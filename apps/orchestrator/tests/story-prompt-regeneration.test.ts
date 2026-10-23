import { describe, expect, it } from "@jest/globals";
import {
  buildForceStages,
  clearScenePromptState,
  promptRegenerationAction,
} from "../src/story/run.js";

/**
 * `--regenerate-prompts` exists because the only other way to force new
 * prompts was `--from S4_visual_plan`, which also forces S5-S8: a style or
 * wording change re-planned the prompts and then rebuilt every image, every
 * narration chunk and the render. The flag narrows that to the prompts.
 */
describe("story prompt regeneration", () => {
  it("forces S4 only, leaving images, audio, alignment and render alone", () => {
    expect([...buildForceStages({ regeneratePrompts: true })]).toEqual([
      "S4_visual_plan",
    ]);
  });

  it("from S4 still forces every later stage, which is the difference", () => {
    expect([...buildForceStages({ from: "S4_visual_plan" })]).toEqual([
      "S4_visual_plan",
      "S5_images",
      "S6_audio",
      "S7_align",
      "S8_render",
    ]);
  });

  it("forces only S5 for explicit scene regeneration", () => {
    expect([...buildForceStages({ regenerateImages: [1, 18] })]).toEqual([
      "S5_images",
    ]);
  });

  it("does not force S5 when --stages excludes it", () => {
    expect([
      ...buildForceStages({
        regenerateImages: [1],
        stages: ["S8_render"],
      }),
    ]).toEqual(["S8_render"]);
  });

  it("forces nothing by default", () => {
    expect([...buildForceStages({})]).toEqual([]);
  });

  it("clears prompt state without touching image, audio or timing state", () => {
    const scenes = [
      {
        status: {
          prompt: "done" as const,
          image: "done" as const,
          audio: "done" as const,
          transcript: "done" as const,
          timing: "done" as const,
        },
        imagePrompt: "A composed prompt.",
        promptFingerprint: "abc123",
        imagePromptWarnings: ["stale warning"],
        image: { path: "scene-001.png" },
        audio: { path: "scene-001.wav" },
      },
    ];

    clearScenePromptState(scenes);

    expect(scenes[0].status.prompt).toBe("pending");
    expect(scenes[0].imagePrompt).toBeUndefined();
    expect(scenes[0].promptFingerprint).toBeUndefined();
    expect(scenes[0].imagePromptWarnings).toEqual([]);
    expect(scenes[0].status.image).toBe("done");
    expect(scenes[0].status.audio).toBe("done");
    expect(scenes[0].image).toEqual({ path: "scene-001.png" });
    expect(scenes[0].audio).toEqual({ path: "scene-001.wav" });
  });

  it("only clears when S4 is actually scheduled", () => {
    expect(promptRegenerationAction({ regeneratePrompts: true })).toBe("clear");
    expect(
      promptRegenerationAction({ regeneratePrompts: true, dryRun: true }),
    ).toBe("skip-dry-run");
    expect(
      promptRegenerationAction({
        regeneratePrompts: true,
        stages: ["S8_render"],
      }),
    ).toBe("skip-stage");
    expect(promptRegenerationAction({})).toBe("none");
  });
});
