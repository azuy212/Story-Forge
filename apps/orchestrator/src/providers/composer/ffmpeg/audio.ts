import fs from "node:fs/promises";
import { probe, runFfmpeg, runFfmpegWithRetry } from "./ffmpeg.js";
import { DEFAULT_MAX_RETRIES } from "../../../utils/constants.js";

export type AudioDurationMode = "shortest" | "pad";
export type AudioMixDuration = "first" | "longest" | "shortest";

export interface AudioConcatInput {
  sceneId: number;
  filePath: string;
  durationMs?: number;
}

export interface AudioConcatResult {
  audioPath: string;
  durationMs: number;
}

/** Concatenate already-generated scene WAVs without inserting or changing time. */
export async function concatAudio(
  inputs: AudioConcatInput[],
  outputPath: string,
): Promise<AudioConcatResult> {
  const ordered = [...inputs].sort((a, b) => a.sceneId - b.sceneId);
  if (ordered.length === 0)
    throw new Error("Cannot concatenate empty audio set");

  const sceneIds = new Set<number>();
  for (const input of ordered) {
    if (sceneIds.has(input.sceneId)) {
      throw new Error(`Duplicate scene audio ID: ${input.sceneId}`);
    }
    sceneIds.add(input.sceneId);

    // FFmpeg inputs are local files only. Scene TTS providers must persist
    // audio to disk before this pipeline stage.
    if (/^[a-z]+:\/\//i.test(input.filePath)) {
      throw new Error(
        `Scene audio must be a local file path, got URL: ${input.filePath}`,
      );
    }
    await fs.stat(input.filePath).catch(() => {
      throw new Error(`Scene audio file not found: ${input.filePath}`);
    });
  }

  // Decode each input independently before concatenation. The concat demuxer
  // assumes every file has an identical codec; if one TTS result is f32 PCM
  // while the others are s16 PCM, stream-copying it doubles that scene's
  // apparent duration. Re-encoding to lossless s16 PCM keeps timing stable
  // across otherwise compatible WAV variants.
  const filterInputs = ordered.map((_, index) => `[${index}:a:0]`).join("");
  const args = ["-y"];
  for (const input of ordered) args.push("-i", input.filePath);
  args.push(
    "-filter_complex",
    `${filterInputs}concat=n=${ordered.length}:v=0:a=1[outa]`,
    "-map",
    "[outa]",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );

  await runFfmpegWithRetry(
    args,
    "concatenate scene narration audio",
    DEFAULT_MAX_RETRIES,
  );

  const result = await probe(outputPath);
  if (!result.hasAudio || result.duration <= 0) {
    throw new Error(
      `Concatenated narration has no usable audio: ${outputPath}`,
    );
  }

  return {
    audioPath: outputPath,
    durationMs: Math.round(result.duration * 1000),
  };
}

export async function addNarration(
  videoPath: string,
  narrationPath: string,
  outputPath: string,
  durationMode?: AudioDurationMode,
): Promise<void> {
  const mode = durationMode ?? "shortest";

  const args: string[] = [
    "-y",
    "-i",
    videoPath,
    "-i",
    narrationPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest", // Always use shortest to prevent video/audio length mismatch
  ];

  if (mode === "pad") {
    // If pad, we need to pad the audio before encoding, but here we are just copying video.
    // To truly pad, we'd need to re-encode audio with apad.
    args.splice(args.length - 1, 0, "-af", "apad");
  }

  args.push(outputPath);

  await runFfmpeg({ args, description: "add narration audio" });
}

export interface AudioMixOptions {
  narrationPath: string;
  bgmPath: string;
  bgmVolume?: number;
  durationMode?: AudioDurationMode;
  mixDuration?: AudioMixDuration;
}

export async function mixNarrationWithBgm(
  videoPath: string,
  opts: AudioMixOptions,
  outputPath: string,
): Promise<void> {
  const bgmVolume = opts.bgmVolume ?? 0.15;
  const mode = opts.durationMode ?? "shortest";
  const mixDuration = opts.mixDuration ?? "first";

  const amixFilter = `[narr][music]amix=inputs=2:duration=${mixDuration}${mode === "pad" ? ",apad" : ""}[outa]`;

  const args: string[] = [
    "-y",
    "-i",
    videoPath,
    "-i",
    opts.narrationPath,
    "-i",
    opts.bgmPath,
    "-filter_complex",
    [
      `[1:a]volume=1.0[narr]`,
      `[2:a]volume=${bgmVolume}[music]`,
      amixFilter,
    ].join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[outa]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest", // Always shortest to match video length
    outputPath,
  ];

  await runFfmpeg({ args, description: "mix narration with background music" });
}
