import type { Scene, SceneAudio } from "../types/index.js";
import { formatSrtTime } from "../utils/subtitle-format.js";
import { buildKaraokeAss, appAssStyle } from "../utils/ass.js";
import type {
  GenerateSubtitlesResult,
  WordTimestamp,
} from "./subtitle-provider.js";

const MIN_WORDS_PER_CUE = 3;
const MAX_WORDS_PER_CUE = 5;
const PUNCTUATION_RE = /[.,!?;:…]$/;

export interface SceneSubtitleProvider {
  generateSceneSubtitles(
    scenes: Scene[],
    audioScenes: SceneAudio[],
  ): Promise<GenerateSubtitlesResult>;
}

/**
 * Builds caption timing from explicit scene boundaries, never across scenes.
 *
 * Word timing inside each scene is PROPORTIONAL: words are spread uniformly
 * over the measured scene audio duration. This is deterministic caption
 * timing, not waveform word alignment.
 */
export class DeterministicSceneSubtitleProvider implements SceneSubtitleProvider {
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

      const words = audio.narration.split(/\s+/).filter(Boolean);
      const durationSeconds = audio.durationMs / 1000;
      for (let i = 0; i < words.length; i++) {
        wordTimestamps.push({
          word: words[i],
          start: sceneStart + (durationSeconds * i) / words.length,
          end: sceneStart + (durationSeconds * (i + 1)) / words.length,
        });
      }
      sceneStart += durationSeconds;
    }

    const groups = groupWordsByScene(wordTimestamps, orderedAudio, sceneById);
    const srt = groups
      .map((group, index) => {
        const startMs = Math.round(group[0].start * 1000);
        const endMs = Math.max(
          startMs + 1,
          Math.round(group[group.length - 1].end * 1000),
        );
        return `${index + 1}\n${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}\n${group.map((w) => w.word).join(" ")}`;
      })
      .join("\n\n");
    const ass = buildKaraokeAss(groups, appAssStyle());

    return { srt, ass, wordTimestamps };
  }
}

function groupWordsByScene(
  words: WordTimestamp[],
  audioScenes: SceneAudio[],
  scenes: Map<number, Scene>,
): WordTimestamp[][] {
  const groups: WordTimestamp[][] = [];
  let wordOffset = 0;

  for (const audio of audioScenes) {
    const scene = scenes.get(audio.sceneId);
    if (!scene) throw new Error(`Missing production scene ${audio.sceneId}`);
    const count = audio.narration.split(/\s+/).filter(Boolean).length;
    const sceneWords = words.slice(wordOffset, wordOffset + count);
    wordOffset += count;

    let current: WordTimestamp[] = [];
    for (let i = 0; i < sceneWords.length; i++) {
      const word = sceneWords[i];
      current.push(word);
      const next = sceneWords[i + 1];
      const shouldCut =
        current.length >= MIN_WORDS_PER_CUE &&
        (i === sceneWords.length - 1 ||
          PUNCTUATION_RE.test(word.word.trim()) ||
          current.length >= MAX_WORDS_PER_CUE);
      if (shouldCut || !next) {
        groups.push(current);
        current = [];
      }
    }
  }

  return groups;
}
