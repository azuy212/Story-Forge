import { copyFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { PipelineError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  probe,
  runFfmpegWithRetry,
} from "../providers/composer/ffmpeg/ffmpeg.js";
import type { TTSProvider } from "../providers/tts-provider.js";
import type { WhisperXProvider } from "../providers/whisperx-provider.js";
import { narrationFidelity, type NarrationFidelity } from "./alignment.js";
import { countWords, splitSentences } from "./sentences.js";
import {
  buildNarrationConcatArgs,
  concatNarrationWithGaps,
} from "./ffmpeg-args.js";
import { detectSilence, measureLoudness } from "./media.js";
import { sceneChunkPath, scenePartPath } from "./paths.js";
import type { JobPaths } from "./paths.js";
import { storyTtsMode } from "./config.js";
import type {
  ResolvedStoryConfig,
  SceneAudioChunkRecord,
  StoryScene,
} from "./types.js";

/**
 * S6 narration audio — DP1: per-scene TTS chunks.
 *
 * Each scene's narration is one chunk. A narration longer than the provider's
 * character budget is split at SENTENCE boundaries into pieces, and the pieces
 * are rejoined with no extra gap, so a chunk is always exactly one scene. Real
 * chunk durations are measured with ffprobe; those measurements — not word
 * counts — are what the timing stage consumes.
 *
 * Story mode always runs per-scene (see `storyTtsMode`): the Shorts pipeline's
 * NARRATION_GENERATION_MODE is never consulted, and WPM tempo normalization is
 * skipped so measured durations are the engine's true output.
 */

/** Split narration into provider-sized pieces at sentence boundaries. */
export function splitForTts(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const pieces: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.trim().length > 0) pieces.push(current.trim());
    current = "";
  };

  for (const sentence of splitSentences(trimmed)) {
    if (sentence.length > maxChars) {
      // A single sentence longer than the budget: split at word boundaries so
      // no piece is ever truncated mid-word.
      pushCurrent();
      let buffer = "";
      for (const word of sentence.split(" ")) {
        if (buffer.length > 0 && buffer.length + word.length + 1 > maxChars) {
          pieces.push(buffer);
          buffer = "";
        }
        buffer = buffer.length > 0 ? `${buffer} ${word}` : word;
      }
      if (buffer.length > 0) pieces.push(buffer);
      continue;
    }
    const candidate = current.length > 0 ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      pushCurrent();
      current = sentence;
    } else {
      current = candidate;
    }
  }
  pushCurrent();
  return pieces;
}

export interface AudioChunkResult {
  sceneId: number;
  path: string;
  durationSec: number;
}

export interface AudioStageResult {
  chunks: AudioChunkResult[];
  masterPath: string;
  masterDurationSec: number;
  gapMs: number;
}

export interface AudioStageOptions {
  scenes: StoryScene[];
  paths: JobPaths;
  config: ResolvedStoryConfig;
  ttsProvider: TTSProvider;
  /** Used for the free-ASR fidelity check and its single re-synthesis. */
  transcriber?: WhisperXProvider;
  voice: string;
  runId: string;
  dryRun?: boolean;
}

/**
 * Free ASR coverage below this fraction means the chunk is missing script
 * words. One automatic re-synthesis runs before the warning is recorded.
 */
export const ASR_COVERAGE_WARN = 0.85;
/** An internal pause longer than this makes the scene feel stalled. */
export const INTERNAL_SILENCE_WARN_SEC = 1.0;
/** Cap on silence-driven re-synthesis per chunk (S8 still gates the master). */
export const MAX_SILENCE_RETAKES = 2;

async function measureCoverage(
  transcriber: WhisperXProvider,
  chunkPath: string,
  narration: string,
  runId: string,
  sceneId: number,
): Promise<NarrationFidelity> {
  const result = await transcriber.align(chunkPath, undefined, {
    runId,
    sceneId,
  });
  return narrationFidelity(
    narration,
    result.wordTimestamps.map((word) => ({
      word: word.word,
      start: word.start,
      end: word.end,
    })),
  );
}

function providerFingerprint(provider: TTSProvider): string {
  return typeof provider.cacheFingerprint === "function"
    ? provider.cacheFingerprint()
    : "default";
}

function plausibleDuration(
  durationSec: number,
  words: number,
  wpm: number,
): boolean {
  if (words === 0) return durationSec > 0;
  const expected = (words / wpm) * 60;
  return durationSec >= expected * 0.5 && durationSec <= expected * 2;
}

export async function runAudioStage(
  options: AudioStageOptions,
): Promise<AudioStageResult> {
  const { scenes, paths, config, ttsProvider, transcriber, voice, runId } =
    options;
  if (storyTtsMode() !== "scene") {
    throw new PipelineError(
      "Story mode only supports per-scene narration chunks",
      "STORY_AUDIO_MODE",
    );
  }

  const fingerprint = providerFingerprint(ttsProvider);
  const chunkResults: AudioChunkResult[] = [];

  for (const scene of scenes) {
    const chunkPath = sceneChunkPath(paths, scene.sceneId);
    const words = countWords(scene.narration);

    // Reuse a chunk whose pieces still match text + provider identity, unless
    // verification is on and this chunk has never been checked: then it is
    // verified in place below instead of being synthesized again.
    let reusable: SceneAudioChunkRecord | undefined;
    if (
      scene.status.audio === "done" &&
      scene.audio &&
      scene.audio.pieces.length > 0 &&
      scene.audio.pieces.every(
        (piece) => piece.providerFingerprint === fingerprint,
      ) &&
      (!config.asrVerify ||
        transcriber === undefined ||
        scene.audio.asrChecked === true)
    ) {
      const piecesText = scene.audio.pieces
        .map((piece) => piece.text)
        .join(" ");
      if (piecesText === scene.narration.trim()) {
        try {
          const info = await stat(scene.audio.path);
          if (info.size > 0) {
            chunkResults.push({
              sceneId: scene.sceneId,
              path: scene.audio.path,
              durationSec: scene.audio.durationSec,
            });
            continue;
          }
        } catch {
          // regenerate below
        }
      }
    } else if (
      scene.status.audio === "done" &&
      scene.audio &&
      scene.audio.pieces.length > 0 &&
      scene.audio.pieces.every(
        (piece) => piece.providerFingerprint === fingerprint,
      ) &&
      scene.audio.pieces.map((piece) => piece.text).join(" ") ===
        scene.narration.trim()
    ) {
      reusable = scene.audio;
    }

    if (options.dryRun) continue;

    const texts = splitForTts(scene.narration, config.ttsMaxChars);
    if (texts.length === 0) {
      scene.status.audio = "failed";
      scene.warnings.push("scene has no narration to synthesize");
      continue;
    }

    const synthesizeChunk = async (force: boolean) => {
      const pieces: SceneAudioChunkRecord["pieces"] = [];
      for (let index = 0; index < texts.length; index++) {
        const text = texts[index];
        const partPath = scenePartPath(paths, scene.sceneId, index + 1);
        const existing = force ? undefined : scene.audio?.pieces[index];
        let durationSec =
          existing && existing.text === text ? existing.durationSec : undefined;

        if (durationSec !== undefined) {
          try {
            const info = await stat(partPath);
            if (info.size === 0) durationSec = undefined;
          } catch {
            durationSec = undefined;
          }
        }

        if (durationSec === undefined) {
          const filename = `scene-${String(scene.sceneId).padStart(3, "0")}-part${String(index + 1).padStart(2, "0")}.wav`;
          const result = await ttsProvider.synthesize({
            text,
            voice,
            filename,
            runId,
            // Story mode measures true durations: never tempo-normalize.
            skipWpmNormalization: true,
          });
          if (resolve(result.audioUrl) !== partPath) {
            await copyFile(result.audioUrl, partPath);
          }
          let probed;
          try {
            probed = await probe(partPath);
          } catch {
            throw new PipelineError(
              `Scene ${scene.sceneId} part ${index + 1} is not decodable audio`,
              "STORY_TTS_INVALID",
            );
          }
          durationSec =
            probed.duration > 0 ? probed.duration : result.durationMs / 1000;
          if (!(durationSec > 0)) {
            throw new PipelineError(
              `Scene ${scene.sceneId} part ${index + 1} synthesized with zero duration`,
              "STORY_TTS_INVALID",
            );
          }
        }

        pieces.push({
          path: partPath,
          durationSec: Math.round(durationSec * 1000) / 1000,
          text,
          providerFingerprint: fingerprint,
        });
      }

      // Join the pieces into the scene chunk with no extra gap.
      if (pieces.length === 1) {
        await copyFile(pieces[0].path, chunkPath);
      } else {
        await runFfmpegWithRetry(
          buildNarrationConcatArgs({
            chunkPaths: pieces.map((piece) => piece.path),
            gapMs: 0,
            outputPath: chunkPath,
          }),
          `join narration pieces for scene ${scene.sceneId}`,
          undefined,
          undefined,
          undefined,
          undefined,
          { runId },
        );
      }

      const probeResult = await probe(chunkPath);
      if (!probeResult.hasAudio || probeResult.duration <= 0) {
        throw new PipelineError(
          `Scene ${scene.sceneId} narration chunk has no usable audio`,
          "STORY_TTS_INVALID",
        );
      }
      return { pieces, durationSec: probeResult.duration };
    };

    let built = reusable
      ? { pieces: reusable.pieces, durationSec: reusable.durationSec }
      : await synthesizeChunk(false);
    let coverage: NarrationFidelity | undefined;
    let resynthesized = reusable?.resynthesized === true;
    let asrChecked = reusable?.asrChecked === true;
    if (transcriber && config.asrVerify) {
      try {
        coverage = await measureCoverage(
          transcriber,
          chunkPath,
          scene.narration,
          runId,
          scene.sceneId,
        );
        asrChecked = true;
        if (coverage.coverage < ASR_COVERAGE_WARN) {
          logger.warn(
            `Scene ${scene.sceneId} narration is missing script words (coverage ${coverage.coverage.toFixed(2)}); re-synthesizing once`,
            { missing: coverage.missing.slice(0, 8) },
          );
          built = await synthesizeChunk(true);
          resynthesized = true;
          coverage = await measureCoverage(
            transcriber,
            chunkPath,
            scene.narration,
            runId,
            scene.sceneId,
          );
        }
      } catch (err) {
        // Attempted: do not re-verify (or re-synthesize) on every resume.
        asrChecked = true;
        scene.warnings.push(
          `free ASR verification failed: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    }

    let silenceRetakes = reusable?.silenceRetakes ?? 0;
    let maxInternalSilenceSec = reusable?.maxInternalSilenceSec ?? 0;
    const internalSilences = async (duration: number) => {
      const silences = await detectSilence(
        chunkPath,
        -50,
        INTERNAL_SILENCE_WARN_SEC,
      );
      return silences.filter((silence) => {
        const start = silence.start ?? 0;
        const end = silence.end ?? duration;
        return start > 0.05 && end < duration - 0.05;
      });
    };
    let internal = await internalSilences(built.durationSec);
    maxInternalSilenceSec = Math.max(
      maxInternalSilenceSec,
      ...internal.map((silence) => silence.duration),
    );
    while (internal.length > 0 && silenceRetakes < MAX_SILENCE_RETAKES) {
      logger.warn(
        `Scene ${scene.sceneId} narration has a ${internal[0].duration.toFixed(2)}s internal pause; re-synthesizing (retake ${silenceRetakes + 1}/${MAX_SILENCE_RETAKES})`,
      );
      built = await synthesizeChunk(true);
      silenceRetakes += 1;
      internal = await internalSilences(built.durationSec);
      maxInternalSilenceSec = Math.max(
        maxInternalSilenceSec,
        ...internal.map((silence) => silence.duration),
      );
    }
    if (internal.length > 0) {
      const message =
        `narration still has a ${internal[0].duration.toFixed(2)}s internal pause` +
        ` after ${silenceRetakes} silence retake(s); S8 will gate the master`;
      if (!scene.warnings.includes(message)) scene.warnings.push(message);
    }

    const { pieces, durationSec } = built;
    const expectedPiecesDuration = pieces.reduce(
      (sum, piece) => sum + piece.durationSec,
      0,
    );
    if (Math.abs(durationSec - expectedPiecesDuration) > 0.1) {
      logger.warn(
        `Scene ${scene.sceneId} chunk duration differs from its pieces`,
        { durationSec, expectedPiecesDuration },
      );
    }
    if (!plausibleDuration(durationSec, words, config.wpm)) {
      scene.warnings.push(
        `narration duration ${durationSec.toFixed(2)}s is outside the plausible 0.5×–2× band for ${words} words at ${config.wpm} wpm`,
      );
    }

    const loudness = await measureLoudness(chunkPath);
    const audio: SceneAudioChunkRecord = {
      path: chunkPath,
      durationSec: Math.round(durationSec * 1000) / 1000,
      pieces,
      meanVolumeDb: loudness.meanDb,
      wordsPerMinute:
        durationSec > 0 ? Math.round((words / durationSec) * 60 * 10) / 10 : 0,
      asrCoverage: coverage?.coverage,
      asrMissing:
        coverage && coverage.missing.length > 0
          ? coverage.missing.slice(0, 12)
          : undefined,
      resynthesized: resynthesized ? true : undefined,
      asrChecked: asrChecked ? true : undefined,
      silenceRetakes: silenceRetakes > 0 ? silenceRetakes : undefined,
      maxInternalSilenceSec:
        maxInternalSilenceSec > 0
          ? Math.round(maxInternalSilenceSec * 1000) / 1000
          : undefined,
    };
    scene.audio = audio;
    scene.status.audio = "done";

    if (coverage && coverage.coverage < ASR_COVERAGE_WARN) {
      const missing = coverage.missing.slice(0, 8).join(", ");
      scene.warnings.push(
        `free ASR heard ${(coverage.coverage * 100).toFixed(0)}% of the script` +
          ` after one re-synthesis` +
          (missing ? ` (missing: ${missing})` : ""),
      );
    }
    chunkResults.push({
      sceneId: scene.sceneId,
      path: chunkPath,
      durationSec: audio.durationSec,
    });
  }

  if (options.dryRun) {
    return {
      chunks: chunkResults,
      masterPath: paths.narration,
      masterDurationSec: 0,
      gapMs: config.sceneGapMs,
    };
  }

  const ordered = [...chunkResults].sort((a, b) => a.sceneId - b.sceneId);
  if (ordered.length !== scenes.length) {
    throw new PipelineError(
      `Narration is incomplete: ${ordered.length} of ${scenes.length} scenes have audio`,
      "STORY_AUDIO_INCOMPLETE",
    );
  }

  await concatNarrationWithGaps({
    chunkPaths: ordered.map((chunk) => chunk.path),
    gapMs: config.sceneGapMs,
    outputPath: paths.narration,
    runId,
  });

  const master = await probe(paths.narration);
  if (!master.hasAudio || master.duration <= 0) {
    throw new PipelineError(
      "Concatenated narration has no usable audio",
      "STORY_TTS_INVALID",
    );
  }

  return {
    chunks: ordered,
    masterPath: paths.narration,
    masterDurationSec: Math.round(master.duration * 1000) / 1000,
    gapMs: config.sceneGapMs,
  };
}

/** Median of a numeric list; the run's own baseline for voice-drift checks. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Voice-drift guard (brief reliability concern): flag chunks whose pace or
 * loudness is a large outlier against the run's own median, so a drifting
 * local synthesis is visible in the manifest instead of shipping silently.
 */
export function findVoiceOutliers(
  scenes: StoryScene[],
): { sceneId: number; reason: string }[] {
  const withAudio = scenes.filter(
    (scene) =>
      scene.audio &&
      scene.audio.wordsPerMinute &&
      scene.status.audio === "done",
  );
  if (withAudio.length < 3) return [];

  const medianWpm = median(
    withAudio.map((scene) => scene.audio?.wordsPerMinute ?? 0),
  );
  const loudnesses = withAudio
    .map((scene) => scene.audio?.meanVolumeDb)
    .filter((value): value is number => typeof value === "number");
  const medianLoudness = loudnesses.length > 0 ? median(loudnesses) : undefined;

  const outliers: { sceneId: number; reason: string }[] = [];
  for (const scene of withAudio) {
    const wpm = scene.audio?.wordsPerMinute ?? 0;
    if (medianWpm > 0 && Math.abs(wpm - medianWpm) / medianWpm > 0.25) {
      outliers.push({
        sceneId: scene.sceneId,
        reason: `pace ${wpm.toFixed(1)} wpm deviates more than 25% from the run median ${medianWpm.toFixed(1)} wpm`,
      });
    }
    const db = scene.audio?.meanVolumeDb;
    if (
      medianLoudness !== undefined &&
      typeof db === "number" &&
      Math.abs(db - medianLoudness) > 6
    ) {
      outliers.push({
        sceneId: scene.sceneId,
        reason: `loudness ${db.toFixed(1)} dB deviates more than 6 dB from the run median ${medianLoudness.toFixed(1)} dB`,
      });
    }
  }
  return outliers;
}
