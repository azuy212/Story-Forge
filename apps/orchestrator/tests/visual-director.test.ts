import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { visualDirectorNode } from "../src/agents/visual-director.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a storyboard director.",
  "---",
  "Narration: {{narration}}",
  "Facts: {{approvedFacts}}",
  "QA Feedback: {{qaFeedback}}",
  "Previous Visual Plan: {{previousVisualPlan}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const NARRATION =
  "Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu. " +
  "Nu xi omicron pi.";

const FACTS = [
  { id: "fact-001", fact: "Fact one.", confidence: "high" },
  { id: "fact-002", fact: "Fact two.", confidence: "high" },
];

function makeScenes(narrations: string[]) {
  return narrations.map((narration, i) => ({
    sceneId: i + 10,
    narration,
    sceneGoal: "Hook",
    visualDescription: "Aerial view",
    sceneType: "landscape" as const,
    cameraShot: "aerial" as const,
    cameraMotion: "drone-flyover" as const,
    transition: "cut" as const,
    emotionalBeat: "mystery" as const,
    references: ["fact-001"],
  }));
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
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function buildResponse(content: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
    model: "test-model",
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("visualDirectorNode", () => {
  it("derives contiguous timestamps from narration word counts", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    expect(out).toHaveLength(4);
    expect(out[0].sceneId).toBe(1);
    expect(out[3].sceneId).toBe(4);
    // sceneIds reindexed even though the LLM used 10..13
    expect(out[0].startSecond).toBe(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startSecond).toBe(out[i - 1].endSecond);
    }
    const total = out.reduce((acc, s) => acc + (s.durationSeconds ?? 0), 0);
    expect(Math.abs(total - 50)).toBeLessThanOrEqual(0.02);
    // 4 scenes, equal word counts -> roughly equal durations
    const durations = out.map((s) => s.durationSeconds ?? 0);
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThanOrEqual(
      1,
    );
  });

  it("requires final scene to carry explicit narrative ending", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    (scenes[3] as any).emotionalBeat = "payoff";
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
    );

    const { promise } = runNode({
      content: {
        title: "Title",
        narration: NARRATION,
        estimatedDurationSeconds: 50,
        ending: {
          type: "open_question",
          narration: "Nu xi omicron pi!",
          visualDirection: "Hold on the final evidence.",
        },
      },
    });
    const result = await promise;

    expect(result.production?.scenes).toHaveLength(4);
    expect(result.production?.scenes?.at(-1)?.emotionalBeat).toBe("payoff");
  });

  it("rejects ending that is not represented by final scene", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    (scenes[3] as any).emotionalBeat = "mystery";
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
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

  it("attaches the previous visual plan on promptQA major_revision", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: makeScenes([
          "Alpha beta gamma delta.",
          "Epsilon zeta eta theta.",
          "Iota kappa lambda mu.",
          "Nu xi omicron pi.",
        ]),
        visualPlans: makePlans(4),
      }),
    );

    const prevScenes = makeScenes([
      "OLD VISUAL CONTENT scene one.",
      "OLD VISUAL CONTENT scene two.",
    ]).map((s, i) =>
      i === 0
        ? {
            ...s,
            sceneType: "portrait",
            assetMode: "source",
            visualDescription: "OLD DESCRIPTION aerial establishing shot",
          }
        : s,
    );
    const prevPlans = makePlans(2).map((p, i) =>
      i === 0
        ? {
            ...p,
            renderStyle: "illustration",
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
    expect(userMsg!.content).toContain("OLD VISUAL CONTENT scene one.");
    expect(userMsg!.content).toContain("OLD VISUAL CONTENT scene two.");
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

  it("does not attach a previous visual plan on a fresh run", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        scenes: makeScenes([
          "Alpha beta gamma delta.",
          "Epsilon zeta eta theta.",
          "Iota kappa lambda mu.",
          "Nu xi omicron pi.",
        ]),
        visualPlans: makePlans(4),
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

  it("repairs paraphrased narration by re-segmenting in code", async () => {
    // Scene narration adds a word ("extra") that is not in the original.
    const scenes = makeScenes([
      "Alpha beta gamma",
      "delta epsilon zeta",
      "eta theta extra",
      "iota kappa lambda mu. Nu xi omicron pi.",
    ]);
    scenes[3].references = ["fact-001"];
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
    );

    const { promise } = runNode();
    const result = await promise;

    const out = result.production?.scenes!;
    const repaired = out.map((s) => s.narration).join(" ");
    const tokens = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    // The repaired narration must cover the original exactly — no dropped or
    // invented words survive.
    expect(tokens(repaired)).toEqual(tokens(NARRATION));
    expect(
      result.diagnostics?.warnings?.some((w) => w.includes("re-segmented")),
    ).toBe(true);
  });

  it("drops hallucinated fact references and dedupes", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    scenes[0].references = ["fact-001", "fact-001", "fact-999"];
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].references).toEqual(["fact-001"]);
    expect(
      result.diagnostics?.warnings?.some((w) => w.includes("hallucinated")),
    ).toBe(true);
  });

  it("normalizes common camera shot synonyms", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]).map((scene) => ({ ...scene, cameraShot: "medium-wide" }));
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.production?.scenes?.every((s) => s.cameraShot === "medium"),
    ).toBe(true);
  });

  it("reports incomplete model responses instead of dereferencing choices", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]).map((scene) => ({ ...scene, cameraShot: "unsupported-shot" }));
    mockGenerate
      .mockResolvedValueOnce(
        buildResponse({ scenes, visualPlans: makePlans(4) }),
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
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(3) }),
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
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
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
    expect(mocks.loadPrompt).toHaveBeenCalledWith("visual-director/v1.md");
  });

  it("prefers newer structural feedback over stale PromptQA feedback", async () => {
    const scenes = makeScenes([
      "Alpha beta gamma delta.",
      "Epsilon zeta eta theta.",
      "Iota kappa lambda mu.",
      "Nu xi omicron pi.",
    ]);
    mockGenerate.mockResolvedValue(
      buildResponse({ scenes, visualPlans: makePlans(4) }),
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
    expect(mocks.loadPrompt).toHaveBeenCalledWith("visual-director/v1.md");
  });
});
