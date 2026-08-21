import type { Scene, SceneAudio } from "../types/index.js";
import type { SceneSubtitleProvider } from "./scene-subtitle-provider.js";
import type { WhisperXProvider } from "./whisperx-provider.js";
import type {
  GenerateSubtitlesResult,
  WordTimestamp,
} from "./subtitle-provider.js";
import { groupWords } from "./whisperx-subtitle-provider.js";
import { formatSrtTime } from "../utils/subtitle-format.js";
import { buildKaraokeAss, appAssStyle } from "../utils/ass.js";

/**
 * Real-provider scene subtitle generator. Aligns each scene's narration audio
 * with WhisperX to obtain real word-level timestamps, offsets them onto the
 * global timeline, and builds scene-bounded SRT plus word-karaoke ASS.
 *
 * Word timestamps are authoritative (from WhisperX); cue grouping reuses the
 * same punctuation/timing-gap strategy as the combined-audio provider.
 */
export class WhisperXSceneSubtitleProvider implements SceneSubtitleProvider {
  constructor(private readonly whisperx: WhisperXProvider) {}

  async generateSceneSubtitles(
    scenes: Scene[],
    audioScenes: SceneAudio[],
  ): Promise<GenerateSubtitlesResult> {
    const sceneById = new Map(scenes.map((scene) => [scene.sceneId, scene]));
    const orderedAudio = [...audioScenes].sort((a, b) => a.sceneId - b.sceneId);

    const wordTimestamps: WordTimestamp[] = [];
    let sceneStart = 0;

    for (const audio of orderedAudio) {
      const scene = sceneById.get(audio.sceneId);
      if (!scene) throw new Error(`Missing production scene ${audio.sceneId}`);

      const { wordTimestamps: sceneWords } = await this.whisperx.align(
        audio.url,
        audio.narration,
      );
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

    const ass = buildKaraokeAss(groups, appAssStyle());

    return { srt, ass, wordTimestamps };
  }
}
