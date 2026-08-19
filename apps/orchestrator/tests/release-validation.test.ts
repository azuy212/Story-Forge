import { jest, describe, it, expect } from "@jest/globals";
import {
  releaseValidationNode,
  validatePackage,
} from "../src/agents/release-validation.node.js";
import type { ProjectState } from "../src/types/index.js";

const DEFAULT_SCENE = {
  sceneId: 1,
  assetUrl: "https://placeholder.local/scene-001.mp4",
  generationPrompt: "Aerial view of a remote island.",
  startSecond: 0,
  endSecond: 10,
  durationSeconds: 10,
  sceneGoal: "",
  visualDescription: "",
  sceneType: "landscape" as const,
  cameraShot: "aerial" as const,
  cameraMotion: "static" as const,
  transition: "cut" as const,
  emphasis: "high" as const,
  assetType: "video" as const,
  filename: "scene-001.mp4",
  extension: "mp4",
  assetId: "asset-scene-001",
  provider: "runway" as const,
  generationMode: "generate" as const,
};

const GOOD_PROBE = {
  width: 1080,
  height: 1920,
  duration: 10,
  hasVideo: true,
  hasAudio: true,
  fps: 30,
};

// 26 words at 10s -> 2.6 wps (within 2.4-2.8)
const NARRATION = Array.from({ length: 26 }, (_, i) => `word${i}`).join(" ");

// Subtitle text must match the narration words (semantic overlap check).
const SRT = `1\n00:00:00,000 --> 00:00:10,000\n${NARRATION}`;

function baseState(): ProjectState {
  return {
    project: { pillar: "Geography", topic: "Test" },
    content: {
      title: "Test Title",
      hook: "Test hook",
      narration: NARRATION,
      estimatedDurationSeconds: 10,
    },
    production: { scenes: [DEFAULT_SCENE] },
    audio: {
      version: 2,
      scenes: [
        {
          sceneId: 1,
          artifactId: "scene-audio-1",
          narration: NARRATION,
          durationMs: 10000,
          url: "https://placeholder.local/scene-001.wav",
        },
      ],
      combinedAudio: {
        artifactId: "combined-audio",
        durationMs: 10000,
        url: "https://placeholder.local/narration.wav",
        sourceSceneArtifactIds: ["scene-audio-1"],
      },
      narrationUrl: "https://placeholder.local/narration.wav",
      narrationDurationMs: 10000,
    },
    subtitles: { srt: SRT, wordTimestamps: [], ass: "" },
    video: {
      videoUrl: "https://placeholder.local/final.mp4",
      durationMs: 10000,
      resolution: "1080x1920",
    },
    metadataOutput: {
      title: "Meta Title",
      description: "Meta description.",
      tags: ["geography"],
      hashtags: ["geo"],
      category: "Education",
      pinnedComment: "What do you think?",
    },
    thumbnail: {
      thumbnailPrompt: "High contrast close-up",
      thumbnailText: "Doesn't Exist?",
      textPosition: "bottom-third",
      colorScheme: "cold blue",
      imageUrl: "https://placeholder.local/thumbnail.png",
    },
    branding: { channel: "TestChannel", creator: "", cta: "" },
    execution: { version: "0.1.0" },
  } as ProjectState;
}

function runNode(state: Partial<ProjectState>, probe?: unknown) {
  return releaseValidationNode(
    { ...baseState(), ...state } as ProjectState,
    { configurable: { probe: probe ?? (async () => GOOD_PROBE) } } as any,
  );
}

describe("releaseValidationNode", () => {
  it("approves a complete valid package", async () => {
    const result = await runNode({});

    expect(result.releaseValidation.status).toBe("approved");
    expect(result.releaseValidation.issues).toEqual([]);
    expect(result.releaseValidation.validations).toContain(
      "Final video exists",
    );
    expect(result.releaseValidation.validations).toContain(
      "Video stream exists",
    );
    expect(result.releaseValidation.validations).toContain(
      "Audio stream exists",
    );
    expect(result.releaseValidation.validations).toContain("FPS > 0");
    expect(result.releaseValidation.validations).toContain(
      "Narration pace 2.4-2.8 wps",
    );
    expect(result.execution?.currentNode).toBe("ReleaseValidation");
  });

  it("validates final media against composer timeline duration", async () => {
    const result = await runNode(
      {
        video: {
          videoUrl: "https://placeholder.local/final.mp4",
          durationMs: 20505,
          resolution: "1080x1920",
          timeline: {
            narrativeDurationMs: 10000,
            narrativeHoldMs: 500,
            outroDurationMs: 10005,
            durationMs: 20505,
          },
        },
      },
      async () => ({ ...GOOD_PROBE, duration: 20.505 }),
    );

    expect(result.releaseValidation.status).toBe("approved");
    expect(result.releaseValidation.validations).toContain(
      "Video duration matches composer timeline",
    );
  });

  it("fatal when videoUrl missing", async () => {
    const result = await runNode({ video: {} } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Final video exists"),
      ),
    ).toBe(true);
  });

  it("fatal when narrationUrl missing", async () => {
    const result = await runNode({ audio: {} } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Narration audio exists"),
      ),
    ).toBe(true);
  });

  it("fatal when srt missing", async () => {
    const result = await runNode({ subtitles: {} } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("SRT subtitles present"),
      ),
    ).toBe(true);
  });

  it("fatal when scene missing assetUrl or prompt", async () => {
    const missingAsset = { ...DEFAULT_SCENE, assetUrl: undefined };
    const result = await runNode({
      production: { scenes: [missingAsset] },
    } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("All scene assets exist"),
      ),
    ).toBe(true);

    const missingPrompt = { ...DEFAULT_SCENE, generationPrompt: undefined };
    const result2 = await runNode({
      production: { scenes: [missingPrompt] },
    } as any);
    expect(
      result2.releaseValidation.issues!.some((i) =>
        i.includes("All scene prompts present"),
      ),
    ).toBe(true);
  });

  it("fatal when scene durations do not sum to target", async () => {
    const scenes = [
      { ...DEFAULT_SCENE, sceneId: 1, durationSeconds: 6 },
      {
        ...DEFAULT_SCENE,
        sceneId: 2,
        startSecond: 6,
        endSecond: 12,
        durationSeconds: 6,
      },
    ];
    const result = await runNode({ production: { scenes } } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Scene durations sum"),
      ),
    ).toBe(true);
  });

  it("rejects combined audio with wrong source identity or duration", async () => {
    const result = await runNode({
      audio: {
        ...baseState().audio,
        combinedAudio: {
          ...baseState().audio!.combinedAudio!,
          durationMs: 11000,
          sourceSceneArtifactIds: ["wrong-scene-artifact"],
        },
      },
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(result.releaseValidation.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Combined audio sources match scene artifacts"),
        expect.stringContaining("Combined audio duration matches scene audio"),
      ]),
    );
  });

  function twoSceneState() {
    return {
      production: {
        scenes: [
          { ...DEFAULT_SCENE, sceneId: 1, durationSeconds: 5 },
          {
            ...DEFAULT_SCENE,
            sceneId: 2,
            startSecond: 5,
            endSecond: 10,
            durationSeconds: 5,
          },
        ],
      },
      audio: {
        version: 2,
        scenes: [
          {
            sceneId: 1,
            artifactId: "a1",
            narration: NARRATION,
            durationMs: 5000,
            url: "scene-001.wav",
          },
          {
            sceneId: 2,
            artifactId: "a2",
            narration: NARRATION,
            durationMs: 5000,
            url: "scene-002.wav",
          },
        ],
        combinedAudio: {
          artifactId: "combined",
          durationMs: 10000,
          url: "narration.wav",
          sourceSceneArtifactIds: ["a1", "a2"],
        },
        narrationUrl: "narration.wav",
        narrationDurationMs: 10000,
      },
    } as const;
  }

  it("fatal when audio manifest version is not 2", async () => {
    const result = await runNode({
      audio: { ...baseState().audio, version: 1 },
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Audio manifest version is 2"),
      ),
    ).toBe(true);
  });

  it("fatal when audio manifest version is missing", async () => {
    const { version, ...audioWithoutVersion } = baseState().audio!;
    const result = await runNode({ audio: audioWithoutVersion } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Audio manifest version is 2"),
      ),
    ).toBe(true);
  });

  it("fatal when production scene IDs are duplicated", async () => {
    const state = twoSceneState();
    const result = await runNode({
      production: {
        scenes: [
          { ...DEFAULT_SCENE, sceneId: 1, durationSeconds: 5 },
          {
            ...DEFAULT_SCENE,
            sceneId: 1,
            startSecond: 5,
            endSecond: 10,
            durationSeconds: 5,
          },
        ],
      },
      audio: state.audio,
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Production scene IDs are unique"),
      ),
    ).toBe(true);
  });

  it("fatal when a scene audio entry is missing", async () => {
    const state = twoSceneState();
    const result = await runNode({
      production: state.production,
      audio: {
        ...state.audio,
        scenes: [state.audio.scenes[0]],
        combinedAudio: {
          ...state.audio.combinedAudio,
          durationMs: 5000,
          sourceSceneArtifactIds: ["a1"],
        },
        narrationDurationMs: 5000,
      },
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Scene audio count matches production"),
      ),
    ).toBe(true);
  });

  it("fatal when an extra scene audio entry exists", async () => {
    const state = twoSceneState();
    const result = await runNode({
      production: { scenes: [state.production.scenes[0]] },
      audio: state.audio,
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Scene audio count matches production"),
      ),
    ).toBe(true);
  });

  it("fatal when scene audio order is reordered", async () => {
    const state = twoSceneState();
    const result = await runNode({
      production: state.production,
      audio: {
        ...state.audio,
        scenes: [state.audio.scenes[1], state.audio.scenes[0]],
        combinedAudio: {
          ...state.audio.combinedAudio,
          sourceSceneArtifactIds: ["a2", "a1"],
        },
      },
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Scene audio order matches production"),
      ),
    ).toBe(true);
  });

  it("fatal when combined source artifact order mismatches", async () => {
    const state = twoSceneState();
    const result = await runNode({
      production: state.production,
      audio: {
        ...state.audio,
        combinedAudio: {
          ...state.audio.combinedAudio,
          sourceSceneArtifactIds: ["a2", "a1"],
        },
      },
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Combined audio sources match scene artifacts"),
      ),
    ).toBe(true);
  });

  it("fatal when combined duration differs from scene sum beyond 50ms", async () => {
    const state = twoSceneState();
    const result = await runNode({
      production: state.production,
      audio: {
        ...state.audio,
        combinedAudio: {
          ...state.audio.combinedAudio,
          durationMs: 10051,
        },
      },
    } as any);

    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Combined audio duration matches scene audio"),
      ),
    ).toBe(true);
  });

  it("fatal when scenes are not contiguous", async () => {
    const scenes = [
      {
        ...DEFAULT_SCENE,
        sceneId: 1,
        startSecond: 2,
        endSecond: 10,
        durationSeconds: 8,
      },
    ];
    const result = await runNode({ production: { scenes } } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Scenes contiguous"),
      ),
    ).toBe(true);
  });

  it("fatal when subtitle cues overlap", async () => {
    const srt = [
      "1\n00:00:00,000 --> 00:00:05,000\nFirst",
      "2\n00:00:04,000 --> 00:00:07,000\nSecond",
    ].join("\n\n");
    const result = await runNode({
      subtitles: { srt, wordTimestamps: [], ass: "" },
    } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Subtitle cues do not overlap"),
      ),
    ).toBe(true);
  });

  it("fatal when cue start not before end", async () => {
    const srt = "1\n00:00:05,000 --> 00:00:02,000\nBad";
    const result = await runNode({
      subtitles: { srt, wordTimestamps: [], ass: "" },
    } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some(
        (i) => i.includes("start") && i.includes("end"),
      ),
    ).toBe(true);
  });

  it("fatal when subtitle runs beyond narration duration", async () => {
    const srt = "1\n00:00:00,000 --> 00:00:12,000\nToo long";
    const result = await runNode({
      subtitles: { srt, wordTimestamps: [], ass: "" },
    } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Subtitle end within narration"),
      ),
    ).toBe(true);
  });

  it("fatal when first subtitle does not start near zero", async () => {
    const srt = "1\n00:00:05,000 --> 00:00:10,000\nLate start";
    const result = await runNode({
      subtitles: { srt, wordTimestamps: [], ass: "" },
    } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("First subtitle starts near zero"),
      ),
    ).toBe(true);
  });

  it("fatal when metadata fields are missing", async () => {
    const result = await runNode({ metadataOutput: undefined } as any);
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Metadata fields present"),
      ),
    ).toBe(true);
  });

  it("fatal when probe reports no audio stream", async () => {
    const result = await runNode({}, async () => ({
      ...GOOD_PROBE,
      hasAudio: false,
    }));
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Audio stream exists"),
      ),
    ).toBe(true);
  });

  it("fatal when probe reports zero fps", async () => {
    const result = await runNode({}, async () => ({ ...GOOD_PROBE, fps: 0 }));
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) => i.includes("FPS > 0")),
    ).toBe(true);
  });

  it("fatal when probe resolution mismatches expected", async () => {
    const result = await runNode({}, async () => ({
      ...GOOD_PROBE,
      width: 720,
      height: 1280,
    }));
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Resolution matches expected"),
      ),
    ).toBe(true);
  });

  it("fatal when probe duration mismatches narration", async () => {
    const result = await runNode({}, async () => ({
      ...GOOD_PROBE,
      duration: 20,
    }));
    expect(result.releaseValidation.status).toBe("fatal");
    expect(
      result.releaseValidation.issues!.some((i) =>
        i.includes("Video duration ≈ narration"),
      ),
    ).toBe(true);
  });

  it("warns (not fatal) when probe unavailable", async () => {
    const probe = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockRejectedValue(new Error("ffprobe not found"));
    const result = await runNode({}, probe);

    expect(result.releaseValidation.status).toBe("approved");
    expect(
      result.diagnostics?.warnings!.some((w) =>
        w.includes("Media probe unavailable"),
      ),
    ).toBe(true);
  });

  it("warns on narration pace outside 2.4-2.8 wps", async () => {
    const result = await runNode({
      content: {
        title: "T",
        narration: "one two three",
        estimatedDurationSeconds: 10,
      },
      subtitles: {
        srt: "1\n00:00:00,000 --> 00:00:10,000\none two three",
        wordTimestamps: [],
        ass: "",
      },
    } as any);
    expect(result.releaseValidation.status).toBe("approved");
    expect(
      result.diagnostics?.warnings!.some((w) => w.includes("Narration pace")),
    ).toBe(true);
  });

  it("skips validation when disabled", async () => {
    const prevRelease = process.env.ENABLE_RELEASE_QA;
    const prevQa = process.env.ENABLE_QA;
    process.env.ENABLE_RELEASE_QA = "false";
    process.env.ENABLE_QA = "false";
    try {
      const result = await runNode({ video: {} } as any);
      expect(result.releaseValidation.status).toBe("approved");
      expect(result.releaseValidation.issues).toEqual([]);
    } finally {
      if (prevRelease === undefined) delete process.env.ENABLE_RELEASE_QA;
      else process.env.ENABLE_RELEASE_QA = prevRelease;
      if (prevQa === undefined) delete process.env.ENABLE_QA;
      else process.env.ENABLE_QA = prevQa;
    }
  });
});

describe("validatePackage", () => {
  it("detects srt cue count zero when unparsable", async () => {
    const state = baseState();
    state.subtitles = { srt: "not a valid srt", wordTimestamps: [], ass: "" };
    const result = await validatePackage(state, async () => GOOD_PROBE);
    expect(result.status).toBe("fatal");
    expect(result.issues.some((i) => i.includes("unparsable"))).toBe(true);
  });
});
