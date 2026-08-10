import fs from "node:fs/promises";
import { runFfmpeg, runFfmpegWithRetry } from "./ffmpeg.js";
import type { EncoderConfig } from "./ffmpeg.js";
import { DEFAULT_MAX_RETRIES } from "../../../utils/constants.js";

export type FadeTransition =
  | "fade"
  | "wipeleft"
  | "wiperight"
  | "wipeup"
  | "wipedown"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown"
  | "circleopen"
  | "circleclose"
  | "pixelize"
  | "dissolve"
  | "fadeblack"
  | "fadewhite";

export interface ConcatInput {
  filePath: string;
  durationSeconds: number;
}

export function buildXfadeFilter(
  inputs: ConcatInput[],
  transitionDuration: number,
  transitionType: FadeTransition,
): { filter: string } {
  const parts: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    parts.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
  }

  let prevLabel = "v0";
  let accumulatedOffset = 0;

  for (let i = 1; i < inputs.length; i++) {
    const transitionLabel = `t${String(i - 1).padStart(2, "0")}`;
    const nextLabel = i < inputs.length - 1 ? transitionLabel : "outv";
    const transitionStart =
      accumulatedOffset + inputs[i - 1].durationSeconds - transitionDuration;

    parts.push(
      `[${prevLabel}][v${i}]xfade=transition=${transitionType}:duration=${transitionDuration}:offset=${transitionStart}[${nextLabel}]`,
    );

    prevLabel = nextLabel;
    accumulatedOffset += inputs[i - 1].durationSeconds - transitionDuration;
  }

  return { filter: parts.join(";\n") };
}

/**
 * Concatenate normalized scenes WITHOUT re-encoding. All scenes share the same
 * encoder, resolution, fps, and pixel format after normalization, so the concat
 * demuxer can stream-copy them. If the copy path fails (e.g. codec parameter
 * mismatch), fall back to a filter-complex re-encode.
 */
export async function concatWithoutTransitions(
  inputs: ConcatInput[],
  outputPath: string,
  encoder: EncoderConfig,
  signal?: AbortSignal,
): Promise<void> {
  const listPath = `${outputPath}.concat.txt`;
  const list = inputs
    .map((i) => `file '${i.filePath.replace(/'/g, `'\\''`)}'`)
    .join("\n");
  await fs.writeFile(listPath, list, "utf-8");

  try {
    await runFfmpegWithRetry(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        outputPath,
      ],
      "concatenate scenes (stream copy)",
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
    );
  } catch {
    // Fallback: filter concat with re-encode. Deterministic failures (codec
    // mismatches) are not retried here — the fallback is the second chance.
    await runFfmpeg({
      args: buildFilterConcatArgs(inputs, outputPath, encoder),
      description: "concatenate scenes (filter concat fallback)",
    });
  }
}

function buildFilterConcatArgs(
  inputs: ConcatInput[],
  outputPath: string,
  encoder: EncoderConfig,
): string[] {
  const inputArgs = inputs.flatMap((i) => ["-i", i.filePath]);
  const streamLabels = inputs.map((_, idx) => `[${idx}:v:0]`).join("");
  const filterArg = `${streamLabels}concat=n=${inputs.length}:v=1:a=0[outv]`;

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterArg,
    "-map",
    "[outv]",
    "-c:v",
    encoder.encoder,
    "-crf",
    String(encoder.crf),
    "-preset",
    encoder.preset,
    "-an",
  ];

  if (encoder.extraArgs) args.push(...encoder.extraArgs);
  args.push(outputPath);
  return args;
}

export async function concatWithTransitions(
  inputs: ConcatInput[],
  outputPath: string,
  transitionDuration: number,
  transitionType: FadeTransition,
  encoder: EncoderConfig,
  signal?: AbortSignal,
): Promise<void> {
  const inputArgs = inputs.flatMap((i) => ["-i", i.filePath]);
  const { filter } = buildXfadeFilter(
    inputs,
    transitionDuration,
    transitionType,
  );

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filter,
    "-map",
    "[outv]",
    "-c:v",
    encoder.encoder,
    "-crf",
    String(encoder.crf),
    "-preset",
    encoder.preset,
    "-an",
  ];

  if (encoder.extraArgs) args.push(...encoder.extraArgs);
  args.push(outputPath);

  await runFfmpegWithRetry(
    args,
    `concatenate scenes with ${transitionType} transitions`,
    DEFAULT_MAX_RETRIES,
    undefined,
    signal,
  );
}
