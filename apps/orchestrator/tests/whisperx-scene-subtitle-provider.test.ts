import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { WhisperXSceneSubtitleProvider } from "../src/providers/whisperx-scene-subtitle-provider.js";
import type { WhisperXProvider } from "../src/providers/whisperx-provider.js";
import type { Scene } from "../src/types/index.js";
import type { SceneAudio } from "../src/schemas/audio.js";

const mockAlign = jest.fn<(...args: any[]) => Promise<any>>();
const whisperx: WhisperXProvider = { align: mockAlign };
const provider = new WhisperXSceneSubtitleProvider(whisperx);

const SCENES: Scene[] = [
  { sceneId: 1, narration: "First scene." },
  { sceneId: 2, narration: "Second scene." },
];

const AUDIO_SCENES: SceneAudio[] = [
  {
    sceneId: 1,
    artifactId: "a1",
    narration: "First scene.",
    durationMs: 2000,
    url: "scene-001.wav",
  },
  {
    sceneId: 2,
    artifactId: "a2",
    narration: "Second scene.",
    durationMs: 3000,
    url: "scene-002.wav",
  },
];

beforeEach(() => {
  mockAlign.mockReset();
});

describe("WhisperXSceneSubtitleProvider", () => {
  it("aligns each scene's audio and offsets timestamps onto the global timeline", async () => {
    mockAlign
      .mockResolvedValueOnce({
        wordTimestamps: [
          { word: "First", start: 0.0, end: 0.4 },
          { word: "scene.", start: 0.4, end: 1.0 },
        ],
      })
      .mockResolvedValueOnce({
        wordTimestamps: [
          { word: "Second", start: 0.0, end: 0.5 },
          { word: "scene.", start: 0.5, end: 1.2 },
        ],
      });

    const result = await provider.generateSceneSubtitles(SCENES, AUDIO_SCENES);

    expect(mockAlign).toHaveBeenNthCalledWith(
      1,
      "scene-001.wav",
      "First scene.",
    );
    expect(mockAlign).toHaveBeenNthCalledWith(
      2,
      "scene-002.wav",
      "Second scene.",
    );

    // Scene 2 words are offset by scene 1 duration (2.0s).
    expect(result.wordTimestamps).toEqual([
      { word: "First", start: 0.0, end: 0.4 },
      { word: "scene.", start: 0.4, end: 1.0 },
      { word: "Second", start: 2.0, end: 2.5 },
      { word: "scene.", start: 2.5, end: 3.2 },
    ]);
  });

  it("never lets a cue cross a scene boundary", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: [
        { word: "one", start: 0.0, end: 0.3 },
        { word: "two", start: 0.3, end: 0.6 },
        { word: "three", start: 0.6, end: 0.9 },
        { word: "four", start: 0.9, end: 1.2 },
        { word: "five", start: 1.2, end: 1.5 },
      ],
    });

    const result = await provider.generateSceneSubtitles(
      [{ sceneId: 1, narration: "one two three four five" }] as Scene[],
      [{ ...AUDIO_SCENES[0], narration: "one two three four five" }],
    );

    const startMs = result.wordTimestamps.map((w) =>
      Math.round(w.start * 1000),
    );
    const endMs = result.wordTimestamps.map((w) => Math.round(w.end * 1000));
    const lastEnd = endMs[endMs.length - 1];
    // All timestamps stay within scene 1's 2000ms duration.
    expect(Math.max(...endMs)).toBeLessThanOrEqual(2000);
    expect(Math.min(...startMs)).toBeGreaterThanOrEqual(0);
    expect(lastEnd).toBeLessThanOrEqual(2000);
  });

  it("produces karaoke ASS with per-word events", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: [
        { word: "First", start: 0.0, end: 0.4 },
        { word: "scene.", start: 0.4, end: 1.0 },
      ],
    });

    const result = await provider.generateSceneSubtitles(
      [{ sceneId: 1, narration: "First scene." }] as Scene[],
      [{ ...AUDIO_SCENES[0] }],
    );

    expect(result.ass).toContain("[Script Info]");
    expect(result.ass).toContain("[Events]");
    expect(result.ass.match(/Dialogue: 0,/g)).toHaveLength(2);
    expect(result.ass).toContain("{\\c&H0000E0FF}");
  });

  it("throws when whisperx returns no timestamps", async () => {
    mockAlign.mockResolvedValue({ wordTimestamps: [] });

    await expect(
      provider.generateSceneSubtitles(
        [{ sceneId: 1, narration: "First scene." }] as Scene[],
        [{ ...AUDIO_SCENES[0] }],
      ),
    ).rejects.toThrow(/no word timestamps/);
  });
});
