import { describe, it, expect } from "@jest/globals";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import {
  buildThumbnailFilterGraph,
  createDefaultThumbnailCompositor,
  FfmpegThumbnailCompositor,
  normalizeTextPosition,
} from "../src/providers/thumbnail-compositor.js";
import { probe } from "../src/providers/composer/ffmpeg/ffmpeg.js";
import { resolveBrandingAssetPath } from "../src/utils/branding.js";

const FONT = resolveBrandingAssetPath("assets/branding/NotoSans-Bold.ttf");

function drawtextChains(filterGraph: string): string[] {
  return filterGraph
    .split(/;(?=\[)/)
    .filter((chain) => chain.includes("drawtext="));
}

function parseChain(chain: string): {
  text: string;
  x: string;
  y: number;
  fontSize: number;
} {
  return {
    text: /text=([^:]+)(?=:fontsize=)/.exec(chain)?.[1] ?? "",
    x: /x=([^:]+)(?=:y=)/.exec(chain)?.[1] ?? "",
    y: Number(/y=(\d+)(?=\[)/.exec(chain)?.[1] ?? -1),
    fontSize: Number(/fontsize=(\d+)/.exec(chain)?.[1] ?? -1),
  };
}

describe("normalizeTextPosition", () => {
  it("accepts the four known positions", () => {
    expect(normalizeTextPosition("bottom-third")).toBe("bottom-third");
    expect(normalizeTextPosition("top-left")).toBe("top-left");
    expect(normalizeTextPosition("top-right")).toBe("top-right");
    expect(normalizeTextPosition("center")).toBe("center");
  });

  it("defaults unknown/empty positions to bottom-third", () => {
    expect(normalizeTextPosition("weird-spot")).toBe("bottom-third");
    expect(normalizeTextPosition("")).toBe("bottom-third");
    expect(normalizeTextPosition(undefined)).toBe("bottom-third");
  });
});

describe("buildThumbnailFilterGraph", () => {
  it("normalizes to 1080x1920 cover crop", () => {
    const graph = buildThumbnailFilterGraph({ text: "T", fontPath: FONT });
    expect(graph).toContain(
      "scale=1080:1920:force_original_aspect_ratio=increase",
    );
    expect(graph).toContain("crop=1080:1920");
  });

  it("renders the exact text with font file, outline, shadow, and backing box", () => {
    const graph = buildThumbnailFilterGraph({
      text: "MYSTERY",
      fontPath: FONT,
    });
    const chain = drawtextChains(graph)[0];
    expect(chain).toContain(`fontfile=${FONT}`);
    expect(chain).toContain("text=MYSTERY");
    expect(chain).toContain("bordercolor=black@0.9");
    expect(chain).toContain("shadowcolor=black@0.85");
    expect(chain).toContain("boxcolor=black@0.42");
    expect(chain).toContain("fontcolor=white");
  });

  it("escapes punctuation accepted by thumbnail text", () => {
    const graph = buildThumbnailFilterGraph({
      text: 'Doesn\'t Exist? 50%, "really"',
      fontPath: FONT,
    });

    expect(graph).toContain("text=Doesn\\'t");
    expect(graph).toContain("text=Exist?\\ 50\\%\\,");
    expect(graph).toContain('text=\\"really\\"');
  });

  it("supports all four text positions with correct alignment", () => {
    const positions = [
      "bottom-third",
      "top-left",
      "top-right",
      "center",
    ] as const;
    for (const position of positions) {
      const graph = buildThumbnailFilterGraph({
        text: "GHOST SHIP MYSTERY",
        textPosition: position,
        fontPath: FONT,
      });
      const chains = drawtextChains(graph);
      expect(chains.length).toBeGreaterThan(0);

      for (const chain of chains) {
        const { x } = parseChain(chain);
        if (position === "top-left") {
          expect(x).toBe("72");
        } else if (position === "top-right") {
          expect(x).toBe("w-text_w-72");
        } else {
          expect(x).toBe("(w-text_w)/2");
        }
      }
    }
  });

  it("keeps text inside safe margins for every position", () => {
    const positions = [
      "bottom-third",
      "top-left",
      "top-right",
      "center",
    ] as const;
    for (const position of positions) {
      const graph = buildThumbnailFilterGraph({
        text: "GHOST SHIP MYSTERY",
        textPosition: position,
        fontPath: FONT,
      });
      const chains = drawtextChains(graph);
      const parsed = chains.map(parseChain);
      const lineHeight = parsed[0].fontSize * 1.18;
      const blockTop = Math.min(...parsed.map((p) => p.y));
      const blockBottom = blockTop + parsed.length * lineHeight;

      // Margin expectations (constants mirror the compositor).
      if (position === "bottom-third") {
        expect(blockBottom).toBeLessThanOrEqual(1920 - 240);
      } else {
        expect(blockTop).toBeGreaterThanOrEqual(160);
      }
      expect(blockTop).toBeGreaterThanOrEqual(0);
      expect(blockBottom).toBeLessThanOrEqual(1920);
    }
  });

  it("wraps long text onto multiple lines instead of overflowing", () => {
    const graph = buildThumbnailFilterGraph({
      text: "THIS CHANGED EVERYTHING FOR EVERYONE FOREVER",
      fontPath: FONT,
    });
    const chains = drawtextChains(graph);
    expect(chains.length).toBeGreaterThan(1);

    for (const chain of chains) {
      const { text, fontSize } = parseChain(chain);
      const estWidth = text.length * fontSize * 0.63;
      // Must fit within 1080 - 2*72 margin.
      expect(estWidth).toBeLessThanOrEqual(1080 - 144);
    }
  });

  it("emits only a normalize filter when text is empty (no drawtext)", () => {
    const graph = buildThumbnailFilterGraph({ text: "", fontPath: FONT });
    expect(drawtextChains(graph)).toHaveLength(0);
    expect(graph).toContain("[0:v]");
    expect(graph).toContain("[out]");
    expect(graph).not.toContain("drawtext");
  });
});

function hasFfmpeg(): boolean {
  try {
    execaSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("FfmpegThumbnailCompositor (real ffmpeg)", () => {
  const maybe = hasFfmpeg() ? describe : describe.skip;

  maybe("composite", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "thumb-composite-"));
      await execaSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=navy:s=1200x1600",
          "-frames:v",
          "1",
          join(dir, "source.png"),
        ],
        { stdio: "ignore" },
      );
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("renders 1080x1920 output with text and leaves the source unchanged", async () => {
      const sourcePath = join(dir, "source.png");
      const before = await readFile(sourcePath);

      const compositor = new FfmpegThumbnailCompositor();
      const result = await compositor.composite({
        sourceUrl: sourcePath,
        text: "Doesn't Exist?",
        textPosition: "bottom-third",
        runId: undefined,
        filename: "thumb.png",
      });

      const info = await probe(result.url);
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);

      const after = await readFile(sourcePath);
      expect(after.equals(before)).toBe(true);
    });

    it("outputs canonical dimensions even when text is empty", async () => {
      const sourcePath = join(dir, "source.png");

      const compositor = new FfmpegThumbnailCompositor();
      const result = await compositor.composite({
        sourceUrl: sourcePath,
        text: "",
        runId: undefined,
        filename: "thumb-empty.png",
      });

      const info = await probe(result.url);
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
      expect(result.url).not.toBe(sourcePath);
    });
  });

  it("passes remote/stub placeholder sources through unchanged", async () => {
    const compositor = new FfmpegThumbnailCompositor();
    const result = await compositor.composite({
      sourceUrl: "https://placeholder.local/thumbnail.png",
      text: "GHOST SHIP",
      textPosition: "bottom-third",
    });
    expect(result.url).toBe("https://placeholder.local/thumbnail.png");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
  });

  it("rejects non-placeholder remote sources", async () => {
    const compositor = new FfmpegThumbnailCompositor();

    await expect(
      compositor.composite({
        sourceUrl: "https://cdn.example.com/thumbnail.png",
        text: "GHOST SHIP",
      }),
    ).rejects.toThrow("Remote thumbnail sources are not supported");
  });

  it("rejects missing local sources", async () => {
    const compositor = new FfmpegThumbnailCompositor();

    await expect(
      compositor.composite({
        sourceUrl: "/tmp/thumbnail-source-does-not-exist.png",
        text: "GHOST SHIP",
      }),
    ).rejects.toThrow("Thumbnail source does not exist");
  });

  it("rejects output paths outside generated/assets", async () => {
    const compositor = new FfmpegThumbnailCompositor();

    await expect(
      compositor.composite({
        sourceUrl: process.cwd(),
        text: "GHOST SHIP",
        runId: "/tmp/outside-thumbnail-dir",
      }),
    ).rejects.toThrow("escapes generated/assets");
  });

  it("exposes a stable fingerprint that includes font and dimensions", () => {
    const compositor = createDefaultThumbnailCompositor();
    expect(compositor.fingerprint()).toContain("1080x1920");
    expect(compositor.fingerprint()).toContain("NotoSans-Bold.ttf");
  });
});
