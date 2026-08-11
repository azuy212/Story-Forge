import fs from "node:fs";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runFfmpeg } from "./composer/ffmpeg/ffmpeg.js";
import { PipelineError } from "../utils/errors.js";
import { resolveBrandingAssetPath } from "../utils/branding.js";

export type ThumbnailTextPosition =
  "bottom-third" | "top-left" | "top-right" | "center";

const KNOWN_POSITIONS = [
  "bottom-third",
  "top-left",
  "top-right",
  "center",
] as const;

export function normalizeTextPosition(pos?: string): ThumbnailTextPosition {
  const normalized = (pos ?? "").trim().toLowerCase();
  return (KNOWN_POSITIONS as readonly string[]).includes(normalized)
    ? (normalized as ThumbnailTextPosition)
    : "bottom-third";
}

export interface ThumbnailComposeOptions {
  sourceUrl: string;
  text: string;
  textPosition?: string;
  colorScheme?: string;
  runId?: string;
  filename?: string;
}

export interface ThumbnailComposeResult {
  url: string;
  width: number;
  height: number;
}

export interface ThumbnailCompositor {
  readonly version: string;
  fingerprint(): string;
  composite(opts: ThumbnailComposeOptions): Promise<ThumbnailComposeResult>;
}

export interface ThumbnailCompositorConfig {
  fontPath?: string;
  width?: number;
  height?: number;
}

const DEFAULT_FONT_PATH = "assets/branding/NotoSans-Bold.ttf";
const OUTPUT_DIR = path.resolve("generated", "assets");

export const THUMBNAIL_DIMENSIONS = { width: 1080, height: 1920 } as const;

// Layout constants tuned for a 1080x1920 Shorts thumbnail.
const MARGIN_X = 72;
const MARGIN_TOP = 160;
const MARGIN_BOTTOM = 240;
const CHAR_WIDTH_FACTOR = 0.63;
const LINE_HEIGHT_FACTOR = 1.18;
const BASE_FONT_SIZE = 180;
const MIN_FONT_SIZE = 48;

const REGION_HEIGHT: Record<ThumbnailTextPosition, number> = {
  "bottom-third": 460,
  "top-left": 400,
  "top-right": 400,
  center: 700,
};

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_WIDTH_FACTOR;
}

function wrapLines(
  words: string[],
  fontSize: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface TextLayout {
  lines: string[];
  fontSize: number;
  lineHeight: number;
}

function fitTextLayout(
  text: string,
  position: ThumbnailTextPosition,
): TextLayout {
  const words = text.split(/\s+/).filter(Boolean);
  const maxWidth = THUMBNAIL_DIMENSIONS.width - MARGIN_X * 2;
  const maxHeight = REGION_HEIGHT[position];

  let fontSize = BASE_FONT_SIZE;
  for (;;) {
    const lines =
      words.length === 0 ? [] : wrapLines(words, fontSize, maxWidth);
    const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
    const totalHeight = lines.length * lineHeight;
    const widest = lines.reduce(
      (max, line) => Math.max(max, estimateTextWidth(line, fontSize)),
      0,
    );

    if (
      lines.length === 0 ||
      (widest <= maxWidth && totalHeight <= maxHeight)
    ) {
      return { lines, fontSize, lineHeight };
    }
    if (fontSize <= MIN_FONT_SIZE) {
      return { lines, fontSize, lineHeight };
    }
    fontSize -= 6;
  }
}

interface PositionedLine {
  text: string;
  x: string;
  y: number;
}

function layoutLines(
  layout: TextLayout,
  position: ThumbnailTextPosition,
): PositionedLine[] {
  const totalHeight = layout.lines.length * layout.lineHeight;

  let blockTop: number;
  switch (position) {
    case "bottom-third":
      blockTop = THUMBNAIL_DIMENSIONS.height - MARGIN_BOTTOM - totalHeight;
      break;
    case "top-left":
    case "top-right":
      blockTop = MARGIN_TOP;
      break;
    case "center":
      blockTop = (THUMBNAIL_DIMENSIONS.height - totalHeight) / 2;
      break;
  }

  return layout.lines.map((line, index) => {
    const y = Math.round(blockTop + index * layout.lineHeight);

    let x: string;
    switch (position) {
      case "top-left":
        x = String(MARGIN_X);
        break;
      case "top-right":
        x = `w-text_w-${MARGIN_X}`;
        break;
      case "bottom-third":
      case "center":
        x = "(w-text_w)/2";
        break;
    }

    return { text: line, x, y };
  });
}

function escapeDrawtextText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/ /g, "\\ ")
    .replace(/%/g, "\\%");
}

function escapeDrawtextPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildDrawtext(
  line: PositionedLine,
  fontSize: number,
  fontPath: string,
): string {
  return [
    "drawtext=",
    `fontfile=${escapeDrawtextPath(fontPath)}`,
    `text=${escapeDrawtextText(line.text)}`,
    `fontsize=${fontSize}`,
    "fontcolor=white",
    "borderw=12",
    "bordercolor=black@0.9",
    "shadowx=8",
    "shadowy=8",
    "shadowcolor=black@0.85",
    "box=1",
    "boxcolor=black@0.42",
    "boxborderw=26",
    `x=${line.x}`,
    `y=${line.y}`,
  ].join(":");
}

function normalizeFilter(width: number, height: number): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    "format=rgb24",
  ].join(",");
}

function isHttpSource(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isStubPlaceholder(url: string): boolean {
  return /^https?:\/\/placeholder\.local\//i.test(url);
}

function isPathWithinDirectory(directory: string, target: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export class FfmpegThumbnailCompositor implements ThumbnailCompositor {
  readonly version = "1.0.0";
  private readonly fontPath: string;
  private readonly width: number;
  private readonly height: number;

  constructor(config?: ThumbnailCompositorConfig) {
    const configuredFont =
      config?.fontPath ?? process.env.THUMBNAIL_FONT_PATH ?? DEFAULT_FONT_PATH;
    this.fontPath = resolveBrandingAssetPath(configuredFont);
    this.width = config?.width ?? THUMBNAIL_DIMENSIONS.width;
    this.height = config?.height ?? THUMBNAIL_DIMENSIONS.height;
  }

  fingerprint(): string {
    return `${this.version}|${this.fontPath}|${this.width}x${this.height}`;
  }

  async composite(
    opts: ThumbnailComposeOptions,
  ): Promise<ThumbnailComposeResult> {
    // Stub mode returns a remote placeholder URL. Preserve stub pipeline
    // behavior while keeping the artifact contract canonical.
    if (isStubPlaceholder(opts.sourceUrl)) {
      return {
        url: opts.sourceUrl,
        width: THUMBNAIL_DIMENSIONS.width,
        height: THUMBNAIL_DIMENSIONS.height,
      };
    }
    if (isHttpSource(opts.sourceUrl)) {
      throw new PipelineError(
        "Remote thumbnail sources are not supported by FFmpeg compositor",
        "THUMBNAIL_SOURCE_ERROR",
      );
    }
    if (!fs.existsSync(opts.sourceUrl)) {
      throw new PipelineError(
        `Thumbnail source does not exist: ${opts.sourceUrl}`,
        "THUMBNAIL_SOURCE_ERROR",
      );
    }

    const filename = opts.filename ?? "thumbnail-composited.png";
    const dir = opts.runId ? path.resolve(OUTPUT_DIR, opts.runId) : OUTPUT_DIR;
    const outputPath = path.resolve(dir, filename);

    if (!isPathWithinDirectory(OUTPUT_DIR, outputPath)) {
      throw new PipelineError(
        "Thumbnail output path escapes generated/assets",
        "THUMBNAIL_OUTPUT_ERROR",
      );
    }

    const filterGraph = buildThumbnailFilterGraph({
      text: opts.text ?? "",
      textPosition: opts.textPosition,
      fontPath: this.fontPath,
      width: this.width,
      height: this.height,
    });

    const args = [
      "-y",
      "-i",
      opts.sourceUrl,
      "-filter_complex",
      filterGraph,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-c:v",
      "png",
      outputPath,
    ];

    try {
      await mkdir(dir, { recursive: true });
      await runFfmpeg({
        args,
        description: "composite thumbnail text",
        timeout: 120_000,
      });
    } catch (err) {
      throw new PipelineError(
        `Thumbnail compositing failed: ${(err as Error)?.message ?? String(err)}`,
        "THUMBNAIL_COMPOSITE_ERROR",
      );
    }

    return {
      url: outputPath,
      width: this.width,
      height: this.height,
    };
  }
}

export interface BuildThumbnailFilterGraphOptions {
  text: string;
  textPosition?: string;
  fontPath: string;
  width?: number;
  height?: number;
}

export function buildThumbnailFilterGraph(
  opts: BuildThumbnailFilterGraphOptions,
): string {
  const width = opts.width ?? THUMBNAIL_DIMENSIONS.width;
  const height = opts.height ?? THUMBNAIL_DIMENSIONS.height;
  const position = normalizeTextPosition(opts.textPosition);
  const layout = fitTextLayout(opts.text.trim(), position);
  const lines = layoutLines(layout, position);

  if (lines.length === 0) {
    return `[0:v]${normalizeFilter(width, height)}[out]`;
  }

  const segments: string[] = [`[0:v]${normalizeFilter(width, height)}[bg]`];
  let prevLabel = "bg";
  lines.forEach((line, index) => {
    const label = index === lines.length - 1 ? "out" : `t${index}`;
    segments.push(
      `[${prevLabel}]${buildDrawtext(line, layout.fontSize, opts.fontPath)}[${label}]`,
    );
    prevLabel = label;
  });
  return segments.join(";");
}

export function createDefaultThumbnailCompositor(): ThumbnailCompositor {
  return new FfmpegThumbnailCompositor();
}
