import {
  resolveVideoProfile,
  checkNarrationDuration,
  wordRangeFor,
} from "../src/utils/video-profile.js";
import {
  scriptPlannerOutputSchema,
  beatCountRangeFor,
} from "../src/schemas/script-planner-output.js";
import { visualDirectorOutputSchema } from "../src/schemas/visual-director-output.js";

function longProfile(overrides: Record<string, unknown> = {}) {
  return resolveVideoProfile(
    { videoProfile: "long", targetDurationSec: 300 },
    { ...overrides },
  );
}

function shortProfile() {
  return resolveVideoProfile({ videoProfile: "short" });
}

function makeBeat(id: number) {
  return {
    beatId: id,
    purpose: `Beat ${id} purpose`,
    viewerQuestion: "Question",
    curiosityQuestion: "Next",
    keyMessage: "Message",
    referencedFacts: ["fact-001"],
    priority: "medium" as const,
    estimatedDurationSeconds: 20,
  };
}

function makeScene(id: number) {
  return {
    sceneId: id,
    narration: "Scene narration text.",
    sceneGoal: "Goal",
    visualDescription: "Visual",
    sceneType: "landscape" as const,
    cameraShot: "wide" as const,
    cameraMotion: "static" as const,
    transition: "cut" as const,
    emotionalBeat: "mystery" as const,
  };
}

function makeVisualPlan(id: number) {
  return {
    sceneId: id,
    renderStyle: "photorealistic" as const,
    colorMood: "cool blue",
    lighting: "soft",
    composition: "rule of thirds",
  };
}

describe("long video profile: min-only enforcement", () => {
  it("sceneDensity.max is null for long, preserving the no-cap contract", () => {
    const profile = longProfile();
    expect(profile.sceneDensity.min).toBe(25);
    expect(profile.sceneDensity.max).toBeNull();
  });

  it("sceneDensity.max remains a number for short", () => {
    const profile = shortProfile();
    expect(profile.sceneDensity.max).toBe(10);
  });

  it("visualDirectorOutputSchema accepts a small floor count for long", () => {
    const schema = visualDirectorOutputSchema(longProfile());
    const scenes = Array.from({ length: 25 }, (_, i) => makeScene(i + 1));
    const plans = scenes.map((s) => makeVisualPlan(s.sceneId));
    const result = schema.safeParse({ scenes, visualPlans: plans });
    expect(result.success).toBe(true);
  });

  it("visualDirectorOutputSchema accepts an unbounded count for long (e.g. 100 scenes)", () => {
    const schema = visualDirectorOutputSchema(longProfile());
    const scenes = Array.from({ length: 100 }, (_, i) => makeScene(i + 1));
    const plans = scenes.map((s) => makeVisualPlan(s.sceneId));
    const result = schema.safeParse({ scenes, visualPlans: plans });
    expect(result.success).toBe(true);
  });

  it("visualDirectorOutputSchema rejects scenes below the long minimum", () => {
    const schema = visualDirectorOutputSchema(longProfile());
    const scenes = Array.from({ length: 24 }, (_, i) => makeScene(i + 1));
    const plans = scenes.map((s) => makeVisualPlan(s.sceneId));
    const result = schema.safeParse({ scenes, visualPlans: plans });
    expect(result.success).toBe(false);
  });

  it("visualDirectorOutputSchema enforces short min and max", () => {
    const schema = visualDirectorOutputSchema(shortProfile());
    const tooFew = Array.from({ length: 3 }, (_, i) => makeScene(i + 1));
    const tooMany = Array.from({ length: 13 }, (_, i) => makeScene(i + 1));
    const plans = (n: number) =>
      Array.from({ length: n }, (_, i) => makeVisualPlan(i + 1));
    expect(
      schema.safeParse({ scenes: tooFew, visualPlans: plans(3) }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ scenes: tooMany, visualPlans: plans(13) }).success,
    ).toBe(false);
  });

  it("scriptPlannerOutputSchema accepts an unbounded beat count for long (e.g. 50 beats)", () => {
    const schema = scriptPlannerOutputSchema(longProfile());
    const beats = Array.from({ length: 50 }, (_, i) => makeBeat(i + 1));
    const result = schema.safeParse({
      content: { title: "Long doc", hook: "Open with surprise." },
      storyType: "discovery",
      storySummary: "A long story.",
      storyBeats: beats,
    });
    expect(result.success).toBe(true);
  });

  it("scriptPlannerOutputSchema enforces short beat min and max", () => {
    const schema = scriptPlannerOutputSchema(shortProfile());
    const tooFew = Array.from({ length: 5 }, (_, i) => makeBeat(i + 1));
    const tooMany = Array.from({ length: 11 }, (_, i) => makeBeat(i + 1));
    const base = {
      content: { title: "Short", hook: "Open." },
      storyType: "discovery" as const,
      storySummary: "A short story.",
    };
    expect(schema.safeParse({ ...base, storyBeats: tooFew }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...base, storyBeats: tooMany }).success).toBe(
      false,
    );
  });

  it("beatCountRangeFor returns min=10, max=null for long", () => {
    expect(beatCountRangeFor(longProfile())).toEqual({ min: 10, max: null });
  });

  it("beatCountRangeFor returns 6-10 for short", () => {
    expect(beatCountRangeFor(shortProfile())).toEqual({ min: 6, max: 10 });
  });

  it("checkNarrationDuration reports no issue for long when words exceed the old short max", () => {
    const profile = longProfile();
    const range = wordRangeFor(profile);
    const longText = Array.from({ length: range.min + 200 }, () => "word").join(
      " ",
    );
    const issues = checkNarrationDuration(profile, longText, 600);
    expect(issues).toEqual([]);
  });

  it("checkNarrationDuration reports a min-word issue for long when below the floor", () => {
    const profile = longProfile();
    const range = wordRangeFor(profile);
    const shortText = "only a few words here now";
    expect(range.min).toBeGreaterThan(
      shortText.split(/\s+/).filter(Boolean).length,
    );
    const issues = checkNarrationDuration(profile, shortText, 300);
    expect(issues.some((i) => i.toLowerCase().includes("word"))).toBe(true);
  });

  it("checkNarrationDuration reports no issue for short within the min-max range", () => {
    const profile = shortProfile();
    const range = wordRangeFor(profile);
    const midpoint = Math.round((range.min + range.max) / 2);
    const text = Array.from({ length: midpoint }, () => "word").join(" ");
    const issues = checkNarrationDuration(
      profile,
      text,
      profile.targetDurationSec,
    );
    expect(issues).toEqual([]);
  });

  it("checkNarrationDuration reports an issue for short outside the min-max range", () => {
    const profile = shortProfile();
    const text = "just a few words";
    const issues = checkNarrationDuration(
      profile,
      text,
      profile.targetDurationSec,
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  it("checkNarrationDuration long: estimated duration below minimum is an issue, above is not", () => {
    const profile = longProfile();
    const minEstimated =
      profile.targetDurationSec - profile.durationToleranceSec;
    const longText = Array.from(
      { length: wordRangeFor(profile).min + 50 },
      () => "word",
    ).join(" ");

    expect(
      checkNarrationDuration(profile, longText, minEstimated - 10).length,
    ).toBeGreaterThan(0);
    expect(checkNarrationDuration(profile, longText, 600).length).toBe(0);
    expect(checkNarrationDuration(profile, longText, 9999).length).toBe(0);
  });

  it("checkNarrationDuration short: estimated duration above max is an issue", () => {
    const profile = shortProfile();
    const maxEstimated =
      profile.targetDurationSec + profile.durationToleranceSec;
    const text = Array.from(
      { length: wordRangeFor(profile).min + 5 },
      () => "word",
    ).join(" ");
    expect(
      checkNarrationDuration(profile, text, maxEstimated + 5).length,
    ).toBeGreaterThan(0);
  });
});
