import type { Scene, SceneAudio, VideoProfileConfig } from "../types/index.js";
import type {
  SceneSubtitleOptions,
  SceneSubtitleProvider,
} from "./scene-subtitle-provider.js";
import type { WhisperXProvider } from "./whisperx-provider.js";
import type {
  GenerateSubtitlesResult,
  WordTimestamp,
} from "./subtitle-provider.js";
import { groupWords } from "./whisperx-subtitle-provider.js";
import { formatSrtTime } from "../utils/subtitle-format.js";
import { buildKaraokeAss, appAssStyle } from "../utils/ass.js";
import type { RunLogSink } from "../utils/run-log.js";
import { appendRunLogEvent } from "../utils/run-log.js";

/**
 * Real-provider scene subtitle generator. Aligns narration audio with WhisperX
 * to obtain real word-level timestamps, offsets them onto the global timeline,
 * and builds scene-bounded SRT plus word-karaoke ASS.
 *
 * Two modes:
 * - Scene mode: each scene has its own audio URL, so each scene is aligned
 *   separately and words are offset onto the global timeline by cumulative
 *   scene duration.
 * - Complete mode: a single combined audio covers every scene (no per-scene
 *   URLs). The combined file is aligned once against the full narration and
 *   the returned word timestamps are already on the global timeline.
 *
 * Word timestamps are authoritative (from WhisperX); cue grouping reuses the
 * same punctuation/timing-gap strategy as the combined-audio provider.
 */
export class WhisperXSceneSubtitleProvider implements SceneSubtitleProvider {
  constructor(private readonly whisperx: WhisperXProvider) {}

  async generateSceneSubtitles(
    scenes: Scene[],
    audioScenes: SceneAudio[],
    profile?: VideoProfileConfig,
    options?: SceneSubtitleOptions,
  ): Promise<GenerateSubtitlesResult> {
    return this.run(scenes, audioScenes, profile, options);
  }

  /** @deprecated Use {@link generateSceneSubtitles} with options. */
  async run(
    scenes: Scene[],
    audioScenes: SceneAudio[],
    profile: VideoProfileConfig | undefined,
    options?: SceneSubtitleOptions,
  ): Promise<GenerateSubtitlesResult> {
    const sink = options?.runLogSink ?? null;
    const runId = options?.runId;
    const orderedAudio = [...audioScenes].sort((a, b) => a.sceneId - b.sceneId);

    // Complete narration mode: no per-scene audio files, so a single combined
    // alignment against the full narration yields the global word timeline.
    if (
      options?.combinedAudioUrl &&
      orderedAudio.every((audio) => !audio.url)
    ) {
      return this.alignCombinedAudio(
        orderedAudio,
        profile,
        sink,
        runId,
        options,
      );
    }

    const sceneById = new Map(scenes.map((scene) => [scene.sceneId, scene]));
    const wordTimestamps: WordTimestamp[] = [];
    let sceneStart = 0;

    for (const audio of orderedAudio) {
      const scene = sceneById.get(audio.sceneId);
      if (!scene) throw new Error(`Missing production scene ${audio.sceneId}`);

      const startedAt = Date.now();
      if (!audio.url) {
        throw new Error(`Missing audio URL for scene ${audio.sceneId}`);
      }
      const { wordTimestamps: sceneWords } = await this.whisperx.align(
        audio.url,
        audio.narration,
        { runId, sceneId: audio.sceneId, runLogSink: sink },
      );
      appendRunLogEvent(sink, {
        event: "scene_event",
        node: "WhisperXSceneSubtitleProvider",
        sceneId: audio.sceneId,
        kind: "end",
        outcome: "resolved",
        wordCount: sceneWords.length,
        durationMs: Date.now() - startedAt,
        runId,
      });
      for (const w of sceneWords) {
        wordTimestamps.push({
          word: w.word,
          start: sceneStart + w.start,
          end: sceneStart + w.end,
        });
      }
      sceneStart += audio.durationMs / 1000;
    }

    if (wordTimestamps.length === 0) {
      throw new Error(
        "WhisperX returned no word timestamps for the narration scenes",
      );
    }

    return buildSubtitleResult(wordTimestamps, profile);
  }

  private async alignCombinedAudio(
    audioScenes: SceneAudio[],
    profile: VideoProfileConfig | undefined,
    sink: RunLogSink | null,
    runId: string | undefined,
    options: SceneSubtitleOptions,
  ): Promise<GenerateSubtitlesResult> {
    const startedAt = Date.now();
    const combinedUrl = options.combinedAudioUrl!;
    const fullNarration =
      options.fullNarration?.trim() ||
      audioScenes.map((audio) => audio.narration).join(" ");

    const { wordTimestamps } = await this.whisperx.align(
      combinedUrl,
      fullNarration,
      { runId, sceneId: audioScenes.length, runLogSink: sink },
    );

    appendRunLogEvent(sink, {
      event: "scene_event",
      node: "WhisperXSceneSubtitleProvider",
      sceneId: audioScenes.length,
      kind: "end",
      outcome: "resolved",
      wordCount: wordTimestamps.length,
      durationMs: Date.now() - startedAt,
      runId,
      mode: "combined",
    });

    if (wordTimestamps.length === 0) {
      throw new Error(
        "WhisperX returned no word timestamps for the combined narration audio",
      );
    }

    return buildSubtitleResult(wordTimestamps, profile);
  }
}

function buildSubtitleResult(
  wordTimestamps: WordTimestamp[],
  profile: VideoProfileConfig | undefined,
): GenerateSubtitlesResult {
  const groups = groupWords(wordTimestamps);
  const cues = groups.map((group, index) => ({
    index: index + 1,
    startMs: Math.round(group[0].start * 1000),
    endMs: Math.round(group[group.length - 1].end * 1000),
    text: group.map((w) => w.word).join(" "),
  }));

  const srt = cues
    .map(
      (c) =>
        `${c.index}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`,
    )
    .join("\n\n");

  const ass = buildKaraokeAss(
    groups,
    appAssStyle({
      playResX: profile?.videoSize.width,
      playResY: profile?.videoSize.height,
    }),
  );

  return { srt, ass, wordTimestamps };
}
