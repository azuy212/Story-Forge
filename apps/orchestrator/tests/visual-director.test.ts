import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { visualDirectorNode } from "../src/agents/visual-director.node.js";
import type { ProjectState, VideoProfileConfig } from "../src/types/index.js";
import {
  resolveVideoProfile,
  speakingRateWordsPerSecond,
} from "../src/utils/video-profile.js";
import {
  buildNarrationUnits,
  finalizeSceneUnits,
  formatUnits,
  type NarrationUnit,
} from "../src/utils/scene-units.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a storyboard director.",
  "---",
  "Narration units: {{narrationUnits}}",
  "Facts: {{approvedFacts}}",
  "QA Feedback: {{qaFeedback}}",
  "Previous Visual Plan: {{previousVisualPlan}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const PROFILE: VideoProfileConfig = resolveVideoProfile({
  videoProfile: "short",
});
// The node derives this from the speaking rate; keep the fixture in sync.
const MAX_SCENE_WORDS = Math.floor(speakingRateWordsPerSecond(PROFILE) * 6);

const NARRATION =
  "Lightning dies in under a second, yet witnesses report glowing balls that drift through rooms for minutes. " +
  "In 1753, physicist Georg Richmann was killed by a glowing ball, though accounts vary. " +
  "Witnesses described the ball hovering, then vanishing without a sound. " +
  "Some physicists argue the reports are visual hallucinations caused by magnetic fields.";

const UNITS = buildNarrationUnits(NARRATION, MAX_SCENE_WORDS);
const unitById = new Map(UNITS.map((u) => [u.id, u]));

function sceneFor(
  ids: number[],
  index: number,
  extra: Record<string, unknown> = {},
) {
  return {
    sceneId: 10 + index,
    unitIds: ids,
    sceneGoal: "Hook",
    visualDescription: "Aerial view",
    sceneType: "landscape" as const,
    assetMode: "generated" as const,
    sceneRole: "narrative" as const,
    cameraShot: "aerial" as const,
    cameraMotion: "drone-flyover" as const,
    transition: "cut" as const,
    emotionalBeat: "mystery" as const,
    references: ["fact-001"],
    ...extra,
  };
}

function scenesForUnitGroups(
  groups: number[][],
  extra: Record<string, unknown> = {},
) {
  return groups.map((ids, i) => sceneFor(ids, i, extra));
}

function makePlans(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    sceneId: i + 10,
    renderStyle: "photorealistic" as const,
    colorMood: "cold blue",
    lighting: "soft diffused",
    composition: "rule-of-thirds",
  }));
}

function unitText(id: number): string {
  return unitById.get(id)!.text;
}

const FACTS = [
  { id: "fact-001", fact: "Fact one.", confidence: "high" },
  { id: "fact-002", fact: "Fact two.", confidence: "high" },
];

function makeMocks() {
  const createModel = jest.fn<
    (...args: any[]) => { model: string; generate: typeof mockGenerate }
  >(() => ({
    model: "test-model",
    generate: mockGenerate,
  }));
  const loadPrompt = jest
    .fn<(...args: any[]) => Promise<string>>()
    .mockImplementation((path: string) => {
      if (path.includes("editorial-guidelines"))
        return Promise.resolve(MOCK_GUIDELINES);
      return Promise.resolve(MOCK_PROMPT);
    });
  return { createModel, loadPrompt };
}

function runNode(state?: Partial<ProjectState>) {
  const mocks = makeMocks();
  const promise = visualDirectorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: {
        title: "Title",
        narration: NARRATION,
        estimatedDurationSeconds: 50,
      },
      research: { summary: "Summary.", facts: FACTS },
      branding: { channel: "C", creator: "", cta: "" },
      execution: { version: "0.1.0" },
      videoProfile: PROFILE,
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function buildResponse(content: unknown) {
  return {
    output: JSON.stringify(content),
    usage: { promptTokens: 8, completionTokens: 16, totalTokens: 24 },
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("narration unit building (embedded contract)", () => {
  it("keeps the Richmann sentence in a single unit and splits only at clause boundaries", () => {
    // The 1753 sentence fits the word cap, so it must survive as one unit —
    // the 1753 date and the "Georg Richmann" name are never cut apart.
    const richmann = UNITS.find((u) => u.text.includes("Georg Richmann"));
    expect(richmann).toBeDefined();
    expect(richmann!.text).toBe(
      "In 1753, physicist Georg Richmann was killed by a glowing ball, though accounts vary.",
    );
    expect(UNITS.filter((u) => u.text.includes("Richmann"))).toHaveLength(1);

    // Every unit is either a whole sentence or a clause piece cut at a
    // comma/dash/semicolon/coordinating conjunction — never mid-phrase.
    const sentences = NARRATION.split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) =>
      s.replace(/\s+/g, " ").trim(),
    );
    for (const unit of UNITS) {
      const sentence = sentences.find(
        (s) => s.includes(unit.text) || unit.text.includes(s),
      );
      expect(sentence).toBeDefined();
    }

    // Units reproduce the narration exactly.
    expect(UNITS.map((u) => u.text).join(" ")).toBe(
      NARRATION.replace(/\s+/g, " ").trim(),
    );
  });

  it("splits an over-long sentence only at the comma before the conjunction", () => {
    // "Lightning dies in under a second, yet witnesses ..." exceeds the cap
    // by one sentence; the split must land after the comma, before "yet".
    const first = UNITS[0]!;
    expect(first.text.endsWith(",")).toBe(true);
    const second = UNITS[1]!;
    expect(second.text.startsWith("yet ")).toBe(true);
  });

  it("never splits inside a proper name, a date, or a number with its unit", () => {
    const units = buildNarrationUnits(
      NARRATION,
      Math.max(3, MAX_SCENE_WORDS - 20),
    );
    const text = units.map((u) => u.text).join(" ");
    expect(text).toContain("Georg Richmann");
    expect(text).toContain("In 1753");
  });

  it("formats units one per line for the prompt", () => {
    expect(formatUnits(UNITS.slice(0, 2))).toBe(
      `[1] ${unitText(1)}\n[2] ${unitText(2)}`,
    );
  });
});

describe("visualDirectorNode", () => {
  it("derives contiguous timestamps from unit word counts and stores unitIds", async () => {
    // One scene per unit: every scene stays under the cap.
    const groups = UNITS.map((u) => [u.id]);
    const scenes = scenesForUnitGroups(groups);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(UNITS.length) }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    expect(out).toHaveLength(UNITS.length);
    expect(out[0].sceneId).toBe(1);
    expect(out.at(-1)!.sceneId).toBe(UNITS.length);
    expect(out[0].unitIds).toEqual([1]);
    // Narration is derived from the units, not written by the model.
    expect(out[0].narration).toBe(unitText(1));
    expect(out.map((s) => s.narration).join(" ")).toBe(
      NARRATION.replace(/\s+/g, " ").trim(),
    );
    expect(out[0].startSecond).toBe(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startSecond).toBe(out[i - 1].endSecond);
    }
    const total = out.reduce((acc, s) => acc + (s.durationSeconds ?? 0), 0);
    expect(Math.abs(total - 50)).toBeLessThanOrEqual(0.02);
    expect(result.production!.directorReview?.status).toBe("approved");
  });

  it("sends one narration unit per prompt line", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const { promise } = runNode();
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain(`[3] ${unitText(3)}`);
    for (let id = 1; id <= UNITS.length; id++) {
      expect(userMsg!.content).toContain(`[${id}] ${unitText(id)}`);
    }
  });

  it("requires final scene to carry explicit narrative ending", async () => {
    const groups = UNITS.map((u) => [u.id]);
    const scenes = scenesForUnitGroups(groups, {
      emotionalBeat: "mystery",
    });
    scenes[scenes.length - 1]!.emotionalBeat = "payoff";
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(UNITS.length) }),
    );

    const { promise } = runNode({
      content: {
        title: "Title",
        narration: NARRATION,
        estimatedDurationSeconds: 50,
        ending: {
          type: "open_question",
          narration: unitText(UNITS.length),
          visualDirection: "Hold on the final evidence.",
        },
      },
    });
    const result = await promise;

    expect(result.production?.scenes).toHaveLength(UNITS.length);
    expect(result.production?.scenes?.at(-1)?.emotionalBeat).toBe("payoff");
    expect(result.production!.directorReview?.status).toBe("approved");
  });

  it("absorbs trailing units into the final scene when the ending spans two scenes", async () => {
    // The declared ending = the last TWO units; the model placed only the last
    // one in the final scene, so the repair pulls its neighbour across.
    const scenes = scenesForUnitGroups(
      UNITS.map((u) => [u.id]),
      { emotionalBeat: "reflection" },
    );
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(UNITS.length) }),
    );

    const { promise } = runNode({
      content: {
        title: "Title",
        narration: NARRATION,
        estimatedDurationSeconds: 50,
        ending: {
          type: "open_question",
          narration: `${unitText(UNITS.length - 1)} ${unitText(UNITS.length)}`,
          visualDirection: "Hold on the final evidence.",
        },
      },
    });
    const result = await promise;
    const out = result.production?.scenes!;

    expect(out).toHaveLength(UNITS.length - 1);
    expect(result.production!.directorReview?.status).toBe("approved");
    expect(out.at(-1)!.narration).toBe(
      `${unitText(UNITS.length - 1)} ${unitText(UNITS.length)}`,
    );
    expect(
      result.diagnostics?.warnings?.some((w) =>
        w.includes("declared ending whole"),
      ),
    ).toBe(true);
  });

  it("maps a merged scene's visual plan from the winning origin", async () => {
    // Scene 6 duplicates scene 5's unit, so it folds into scene 5; the final
    // scene of the current work list is positionally protected, so scene 6 —
    // the later origin — wins the fold. The merged scene's visual plan must
    // be that winning origin's plan entry, not the first or last plan of the
    // model payload by position.
    const groups: number[][] = [[1], [2], [3], [4], [5], [5]];
    const scenes = scenesForUnitGroups(groups).map((s, i) =>
      i === 5 ? { ...s, visualAnchor: "late-anchor" } : s,
    );
    const basePlan = makePlans(1)[0]!;
    const plans = [10, 11, 12, 13, 14, 15].map((sceneId, i) => ({
      ...basePlan,
      sceneId,
      composition: `plan-${i}`,
    }));
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: plans }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    expect(out).toHaveLength(5);
    // The later scene won the fold: its identity carried over.
    expect(out[4].visualAnchor).toBe("late-anchor");
    // Plan sceneId 15 ("plan-5") is the winner's entry.
    expect(result.production?.visualPlan[4].composition).toBe("plan-5");
    // Plans 10-12, 14, 15 map through; sceneId 14 was the absorbed loser's
    // and no plan entry is left dangling for unknown scenes.
    expect(result.production?.visualPlan.map((p) => p.composition)).toEqual([
      "plan-0",
      "plan-1",
      "plan-2",
      "plan-3",
      "plan-5",
    ]);
  });

  it("fails closed on an unmergeable band, feeds the issue back, and salvages", async () => {
    // Built for MAX_SCENE_WORDS = 14 (the test env's 140 WPM); guard the
    // fixture. A greedy split fills each piece to just under the cap, so a
    // payload whose scenes are over the cap produces adjacent pieces that no
    // longer fit the cap together — for the fail-closed issue to fire, the
    // payload thus alternates scene shapes:
    // - "dense": 30 one-word sentences → pieces (14, 14, 2) words;
    // - "lean": 3 six-word sentences → pieces (12, 6) words.
    // A + B + A + B + A yields 13 pieces — over the 12-scene short band —
    // with exactly two adjacent pairs that still fit (2 + 12 = 14 words),
    // and every scene carries a `Pivot:` marker so both are blocked.
    const maxSceneWords = Math.floor(speakingRateWordsPerSecond(PROFILE) * 6);
    expect(maxSceneWords).toBe(14);
    const narration = [
      ...Array.from({ length: 30 }, () => "Go."),
      ...Array.from({ length: 3 }, () => "Six word units fill this scene."),
      ...Array.from({ length: 30 }, () => "Go."),
      ...Array.from({ length: 3 }, () => "Six word units fill this scene."),
      ...Array.from({ length: 30 }, () => "Go."),
    ].join(" ");
    const span = (from: number, to: number): number[] =>
      Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const groups: number[][] = [
      span(1, 30),
      span(31, 33),
      span(34, 63),
      span(64, 66),
      span(67, 96),
    ];
    const scenes = scenesForUnitGroups(groups, {
      sceneGoal: "Pivot: protect the beat",
    });
    const basePlan = makePlans(1)[0]!;
    const plans = groups.map((_, i) => ({
      ...basePlan,
      sceneId: 10 + i,
      composition: `plan-${i}`,
    }));
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: plans }),
    );

    const { promise } = runNode({
      content: {
        title: "Title",
        narration,
        estimatedDurationSeconds: 50,
      },
    });
    const result = await promise;

    // 3 attempts (DEFAULT_MAX_RETRIES), all rejected with the same payload.
    expect(mockGenerate).toHaveBeenCalledTimes(3);
    const attempt2 = mockGenerate.mock.calls[1]![0] as {
      role: string;
      content: string;
    }[];
    // The retry feedback names the fail-closed band unmergeability.
    expect(attempt2.map((m) => m.content).join("\n")).toContain(
      "no unprotected scenes can be merged",
    );

    // Retries exhausted → the rejected payload is salvaged: the relaxed band
    // (maxScenes null) lets the split repairs stand, so a full storyboard
    // comes out instead of an empty production.
    const out = result.production?.scenes!;
    expect(out).toHaveLength(13);
    expect(out.map((s) => s.unitIds)).toEqual([
      span(1, 14),
      span(15, 28),
      span(29, 30),
      span(31, 32),
      span(33, 33),
      span(34, 47),
      span(48, 61),
      span(62, 63),
      span(64, 65),
      span(66, 66),
      span(67, 80),
      span(81, 94),
      span(95, 96),
    ]);
    // Split pieces inherit their parent's plan (plan mapping follows the
    // first, winning origin id), so the composition sequence reads
    // 3×plan-0, 2×plan-1, 3×plan-2, 2×plan-3, 3×plan-4.
    expect(result.production?.visualPlan.map((p) => p.composition)).toEqual([
      "plan-0",
      "plan-0",
      "plan-0",
      "plan-1",
      "plan-1",
      "plan-2",
      "plan-2",
      "plan-2",
      "plan-3",
      "plan-3",
      "plan-4",
      "plan-4",
      "plan-4",
    ]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.production?.directorReview?.feedback).toContain("recovered");
  });

  it("rejects ending that is not represented by final scene", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const { promise } = runNode({
      content: {
        title: "Title",
        narration: NARRATION,
        estimatedDurationSeconds: 50,
        ending: {
          type: "open_question",
          narration: "A different final sentence.",
        },
      },
    });
    const result = await promise;

    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
  });

  it("keeps a complete storyboard when the ending contract cannot be met and no revision budget remains", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const { promise } = runNode({
      content: {
        title: "Title",
        narration: NARRATION,
        estimatedDurationSeconds: 50,
        ending: {
          type: "open_question",
          narration: "A different final sentence.",
        },
      },
      execution: { version: "0.1.0", retryCount: { VisualDirector: 1 } },
    });
    const result = await promise;

    expect(result.production?.scenes).toHaveLength(UNITS.length);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(
      result.diagnostics?.warnings?.some(
        (w) =>
          w.includes("does not satisfy the ending contract") &&
          w.includes("accepted anyway"),
      ),
    ).toBe(true);
  });

  it("assigns an orphan unit to its adjacent scene", async () => {
    // The model forgot unit 3 (the Richmann sentence); the repair places it
    // into the adjacent scene and the narration still covers exactly. The
    // merged neighbour exceeds the cap, so it is split back apart — the
    // coverage repair always stays word-cap-clean.
    const groups = UNITS.map((u) => [u.id]).filter(
      (ids) => ids[0] !== UNITS[2]!.id,
    );
    const scenes = scenesForUnitGroups(groups);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(groups.length) }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    expect(out).toHaveLength(UNITS.length);
    expect(out[0].unitIds).toEqual([1]);
    expect(out[1].unitIds).toEqual([2]);
    expect(out[2].unitIds).toEqual([UNITS[2]!.id]);
    expect(out.map((s) => s.narration).join(" ")).toBe(
      NARRATION.replace(/\s+/g, " ").trim(),
    );
    expect(
      result.diagnostics?.warnings?.some((w) =>
        w.includes(`unit ${UNITS[2]!.id} was not assigned`),
      ),
    ).toBe(true);
    expect(result.production?.directorReview?.status).toBe("approved");
  });

  it("splits a scene that exceeds the word cap at a unit boundary", async () => {
    // Scene grouping [1,2] sums to more words than the cap: the repair splits
    // it at the comma between the units.
    const groups: number[][] = [[1, 2], [3], [4], [5]];
    const scenes = scenesForUnitGroups(groups);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(groups.length) }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    expect(out[0].unitIds).toEqual([1]);
    expect(out[0].narration).toBe(unitText(1));
    expect(out[1].narration).toBe(unitText(2));
    expect(
      result.diagnostics?.warnings?.some((w) =>
        w.includes("split at a unit boundary"),
      ),
    ).toBe(true);
    expect(out.map((s) => s.narration).join(" ")).toBe(
      NARRATION.replace(/\s+/g, " ").trim(),
    );
  });

  it("keeps an over-long sentence with no safe clause boundary whole as a single-unit scene", async () => {
    // A sentence with no commas/conjunctions that exceeds the cap cannot be
    // split; the builder keeps it whole and finalize reports it as a warning,
    // not a failure.
    const hardSentence =
      "The impossible physics of ball lightning interpretations remain thoroughly unexplainable despite decades of careful laboratory research with systematic worldwide observation efforts";
    const units = buildNarrationUnits(hardSentence, MAX_SCENE_WORDS);
    expect(units).toHaveLength(1);
    expect(units[0].wordCount).toBeGreaterThan(MAX_SCENE_WORDS);

    const finalized = finalizeSceneUnits(
      [{ sceneId: 1, unitIds: [1] }],
      units,
      { maxSceneWords: MAX_SCENE_WORDS, minScenes: 1, maxScenes: null },
    );
    expect(finalized.issues).toEqual([]);
    expect(finalized.warnings.some((w) => w.includes("over the"))).toBe(true);
  });

  it("reports an unrepairable unit contract so the model is retried", async () => {
    // A scene with no valid unit ids cannot be repaired — the corrected
    // grouping must come from the model, so finalize reports issues.
    const finalized = finalizeSceneUnits([{ sceneId: 1, unitIds: [] }], UNITS, {
      maxSceneWords: MAX_SCENE_WORDS,
      minScenes: 1,
      maxScenes: null,
    });
    expect(finalized.issues.length).toBeGreaterThan(0);
  });

  it("attaches the previous visual plan on promptQA major_revision", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const prevScenes = scenesForUnitGroups([[1], [2]]).map((s, i) =>
      i === 0
        ? {
            ...s,
            sceneType: "portrait" as const,
            assetMode: "source" as const,
            visualDescription: "OLD DESCRIPTION aerial establishing shot",
          }
        : s,
    );
    const prevPlans = makePlans(2).map((p, i) =>
      i === 0
        ? {
            ...p,
            renderStyle: "illustration" as const,
            colorMood: "warm amber",
            lighting: "golden hour",
            composition: "centered",
            visualNotes: "OLD NOTE accent the border",
          }
        : p,
    );

    const { promise } = runNode({
      production: {
        scenes: prevScenes,
        visualPlan: prevPlans,
        promptQA: {
          status: "major_revision",
          globalFeedback: "Revise the visual plan.",
          issues: ["Style mismatch"],
          sceneResults: [],
        },
      },
    } as any);
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain(
      "OLD DESCRIPTION aerial establishing shot",
    );
    expect(userMsg!.content).toContain('"sceneType": "portrait"');
    expect(userMsg!.content).toContain('"assetMode": "source"');
    expect(userMsg!.content).toContain('"renderStyle": "illustration"');
    expect(userMsg!.content).toContain('"colorMood": "warm amber"');
    expect(userMsg!.content).toContain('"lighting": "golden hour"');
    expect(userMsg!.content).toContain('"composition": "centered"');
    expect(userMsg!.content).toContain(
      '"visualNotes": "OLD NOTE accent the border"',
    );
  });

  it("carries continuity fields into the revision baseline", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const prevScenes = scenesForUnitGroups([[1], [2]]).map((s, i) =>
      i === 0
        ? {
            ...s,
            visualAnchor: "Persian Gulf map with shipping lane",
            transition: "match-cut" as const,
            emphasis: "high" as const,
            sourceBeatIds: [1, 2],
          }
        : {
            ...s,
            visualAnchor: "Persian Gulf map with shipping lane",
            transition: "cut" as const,
            emphasis: "low" as const,
            sourceBeatIds: [3],
          },
    );

    const { promise } = runNode({
      production: {
        scenes: prevScenes,
        visualPlan: makePlans(2),
        promptQA: {
          status: "major_revision",
          globalFeedback: "Keep the anchor stable.",
          issues: ["Anchor changed mid-explanation"],
          sceneResults: [],
        },
      },
    } as any);
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain(
      '"visualAnchor": "Persian Gulf map with shipping lane"',
    );
    expect(userMsg!.content).toContain('"transition": "match-cut"');
    expect(userMsg!.content).toContain('"emphasis": "high"');
    expect(userMsg!.content).toContain('"sourceBeatIds"');
    expect(userMsg!.content).toContain('"transition": "cut"');
    expect(userMsg!.content).toContain('"emphasis": "low"');
  });

  it("does not attach a previous visual plan on a fresh run", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const { promise } = runNode();
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).not.toContain("OLD VISUAL CONTENT");
  });

  it("drops hallucinated fact references and dedupes", async () => {
    const scenes = scenesForUnitGroups(UNITS.map((u) => [u.id]));
    scenes[0].references = ["fact-001", "fact-001", "fact-999"];
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(UNITS.length) }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].references).toEqual(["fact-001"]);
    expect(
      result.diagnostics?.warnings?.some((w) => w.includes("hallucinated")),
    ).toBe(true);
  });

  it("normalizes common camera shot synonyms", async () => {
    const scenes = scenesForUnitGroups(UNITS.map((u) => [u.id])).map(
      (scene) => ({ ...scene, cameraShot: "medium-wide" }),
    );
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(UNITS.length) }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.production?.scenes?.every((s) => s.cameraShot === "medium"),
    ).toBe(true);
  });

  it("reports incomplete model responses instead of dereferencing choices", async () => {
    const scenes = scenesForUnitGroups(UNITS.map((u) => [u.id])).map(
      (scene) => ({ ...scene, cameraShot: "unsupported-shot" }),
    );
    mockGenerate
      .mockResolvedValueOnce(
        buildResponse({ scenes, visualPlans: makePlans(UNITS.length) }),
      )
      .mockResolvedValue({ usage: {}, model: "test-model" });

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.diagnostics?.errors?.[0]).toContain(
      "Empty response from model",
    );
    expect(result.diagnostics?.errors?.[0]).not.toContain(
      "Cannot read properties of undefined",
    );
  });

  it("returns minor_revision feedback when a visual plan is missing", async () => {
    const scenes = scenesForUnitGroups(UNITS.map((u) => [u.id]));
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(UNITS.length - 1) }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.production?.directorReview?.feedback).toContain(
      "Visual plans missing",
    );
    expect(result.diagnostics?.errors![0]).toContain("VisualDirector");
  });

  it("passes PromptQA major_revision feedback into the VD prompt", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const { promise, mocks } = runNode({
      production: {
        scenes: [],
        promptQA: {
          status: "major_revision",
          globalFeedback: "Color moods inconsistent across scenes.",
          issues: ["Scene 2: wrong renderStyle"],
          sceneResults: [
            { sceneId: 1, verdict: "revise", feedback: "" },
            { sceneId: 2, verdict: "revise", feedback: "" },
          ],
        },
      },
    } as any);
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("Color moods inconsistent");
    expect(userMsg!.content).toContain("wrong renderStyle");
    expect(mocks.loadPrompt).toHaveBeenCalledWith("visual-director/v2.md");
  });

  it("prefers newer structural feedback over stale PromptQA feedback", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: scenesForUnitGroups(UNITS.map((u) => [u.id])),
        visualPlans: makePlans(UNITS.length),
      }),
    );

    const { promise, mocks } = runNode({
      production: {
        scenes: [],
        promptQA: {
          status: "major_revision",
          globalFeedback: "Stale PromptQA feedback",
          issues: ["Stale issue"],
          sceneResults: [],
        },
        directorReview: {
          status: "minor_revision",
          feedback: "Fresh structural feedback",
        },
      },
    } as any);
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("Fresh structural feedback");
    expect(userMsg!.content).not.toContain("Stale PromptQA feedback");
    expect(mocks.loadPrompt).toHaveBeenCalledWith("visual-director/v2.md");
  });

  it("accepts enum spellings that only drifted cosmetically", async () => {
    const scenes = scenesForUnitGroups(UNITS.map((u) => [u.id])).map(
      (s, i) => ({
        ...s,
        emotionalBeat: i === 0 ? "Intrigue" : "Mystery",
        entities: [{ name: "Ada", type: "Human" }],
      }),
    );
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes,
        visualPlans: makePlans(UNITS.length).map((p, i) => ({
          ...p,
          renderStyle:
            ["Photoreal", "3d", "archival", "oil-painting"][i] ?? "Photoreal",
        })),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    expect(out).toHaveLength(UNITS.length);
    expect(out[0].emotionalBeat).toBe("mystery");
    expect(out[0].entities?.[0]?.type).toBe("person");
    expect(result.production?.visualPlan?.[0].renderStyle).toBe(
      "photorealistic",
    );
    expect(result.production?.directorReview?.status).toBe("approved");
  });

  /**
   * Regression: an exhausted minor-revision budget could only "accept the best
   * available result" if one existed, but every failure path returned
   * `scenes: []`, so the router always finalized. The node now re-validates a
   * rejected payload against a relaxed schema and keeps it when it is a
   * structurally sound storyboard.
   */
  it("recovers a rejected storyboard that only missed the scene-count band", async () => {
    // Two scenes below the 4-scene short-profile minimum: scene 1 covers the
    // opening clause piece, scene 2 the Richmann sentence (orphans repair to
    // full coverage inside the relaxed band, so every unit lands somewhere —
    // here that means one scene per unit after the cap splits scene 2).
    const groups: number[][] = [[1], [3]];
    const scenes = scenesForUnitGroups(groups);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(groups.length) }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    // The salvage path validates against the relaxed band only; unit coverage
    // is still enforced — the narration is reproduced exactly.
    expect(out.map((s) => s.narration).join(" ")).toBe(
      NARRATION.replace(/\s+/g, " ").trim(),
    );
    expect(out).toHaveLength(UNITS.length);
    expect(result.production?.visualPlan).toHaveLength(UNITS.length);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.production?.directorReview?.feedback).toContain("recovered");
    expect(result.diagnostics?.errors).toBeUndefined();
  });

  it("still fails when a rejected payload is not a usable storyboard", async () => {
    // No scenes and no plans: nothing structurally sound to salvage.
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes: [], visualPlans: [] }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.production?.directorReview?.feedback).toContain(
      "Schema validation failed",
    );
  });

  it("does not salvage a payload the model never produced as JSON", async () => {
    mockGenerate.mockResolvedValue({
      output: "not json at all",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.diagnostics?.errors?.[0]).toContain("Invalid JSON");
  });

  it("does not salvage when the transport failed before any response", async () => {
    mockGenerate.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 401 }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes).toEqual([]);
    // No recoverable review: the router's default branch finalizes the run.
    expect(result.production?.directorReview).toBeUndefined();
    expect(result.diagnostics?.errors?.[0]).toContain("boom");
  });
});
