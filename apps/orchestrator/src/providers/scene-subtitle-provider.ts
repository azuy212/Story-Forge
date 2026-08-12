import type { Scene, SceneAudio } from "../types/index.js";
import { formatAssTime, formatSrtTime } from "../utils/subtitle-format.js";
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

    const cues = groupWordsByScene(wordTimestamps, orderedAudio, sceneById);
    const srt = cues
      .map(
        (cue, index) =>
          `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`,
      )
      .join("\n\n");
    const ass = cues
      .map(
        (cue) =>
          `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},Default,,0,0,0,,${cue.text}`,
      )
      .join("\n");

    return { srt, ass, wordTimestamps };
  }
}

interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

function groupWordsByScene(
  words: WordTimestamp[],
  audioScenes: SceneAudio[],
  scenes: Map<number, Scene>,
): Cue[] {
  const cues: Cue[] = [];
  let offset = 0;
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
        const startMs = Math.round(current[0].start * 1000);
        const endMs = Math.min(
          Math.round((offset + audio.durationMs / 1000) * 1000),
          Math.round(current.at(-1)!.end * 1000),
        );
        cues.push({
          startMs,
          endMs: Math.max(startMs + 1, endMs),
          text: current.map((item) => item.word).join(" "),
        });
        current = [];
      }
    }

    offset += audio.durationMs / 1000;
  }

  return cues;
}
