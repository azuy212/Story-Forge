import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestCases } from "../src/eval/harvest.js";
import { buildQuestions, answersToPrediction } from "../src/eval/gates.js";
import { replayCases } from "../src/eval/replay.js";
import type { Classifier } from "../src/classifiers/types.js";
import type { ClassificationResult } from "../src/classifiers/types.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function fixtureRun(root: string): string {
  const runDir = join(root, "20260911-162616.811-point-nemo");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });

  writeJson(join(runDir, "run.json"), {
    pillar: "Geography",
    topic: "Point Nemo",
  });

  writeJson(join(runDir, "artifacts/research/v1.json"), {
    data: {
      summary: "Point Nemo is the oceanic pole of inaccessibility.",
      facts: [
        {
          id: "fact-001",
          fact: "Point Nemo is farthest from land.",
          confidence: "high",
          sourceType: "general-knowledge",
          classification: "verified",
        },
        {
          id: "fact-002",
          fact: "Spacecraft are deorbited there.",
          confidence: "medium",
          sourceType: "general-knowledge",
        },
      ],
    },
    meta: { model: "research-model" },
  });

  writeJson(join(runDir, "artifacts/researchQA/v1.json"), {
    data: {
      status: "major_revision",
      feedback: "Fact classification wrong",
      issues: ["fact-002 misclassified"],
      factVerdicts: [
        {
          factId: "fact-001",
          verdict: "keep",
          reason: "accurate",
        },
        {
          factId: "fact-002",
          verdict: "revise",
          reason: "needs source",
        },
      ],
    },
    meta: {
      model: "nemotron",
      promptTokens: 400,
      completionTokens: 80,
      durationMs: 2100,
    },
  });

  writeJson(join(runDir, "artifacts/script/v1.json"), {
    data: {
      content: {
        script: "In the middle of the Pacific lies Point Nemo...",
        narration: "In the middle of the Pacific lies Point Nemo...",
        callToAction: "Subscribe for more.",
        estimatedDurationSeconds: 58,
      },
    },
  });

  writeJson(join(runDir, "artifacts/scriptPlan/v1.json"), {
    data: {
      content: { title: "Point Nemo", hook: "The loneliest place on Earth" },
      storyType: "discovery",
      storySummary: "Why Point Nemo is remote",
      storyBeats: [
        {
          beatId: 1,
          purpose: "Hook",
          curiosityQuestion: "Where is nowhere?",
          keyMessage: "Point Nemo is the farthest place from land.",
        },
      ],
    },
  });

  writeJson(join(runDir, "artifacts/scriptQA/v1.json"), {
    data: {
      status: "approved",
      feedback: "",
      issues: [],
    },
    meta: { model: "script-qa-model", durationMs: 900 },
  });

  writeJson(join(runDir, "artifacts/visualDirector/v1.json"), {
    data: {
      scenes: [
        {
          sceneId: 1,
          narration: "Pacific emptiness",
          visualDescription: "Open ocean",
          assetType: "image",
          assetMode: "generate",
        },
        {
          sceneId: 2,
          narration: "Deorbit burn",
          visualDescription: "Falling satellite",
          assetType: "image",
          assetMode: "generate",
        },
      ],
      visualPlans: [
        {
          sceneId: 1,
          renderStyle: "3D",
          colorMood: "deep blue",
          lighting: "harsh sun",
          composition: "horizon center",
        },
      ],
    },
  });

  writeJson(join(runDir, "artifacts/assets/v1.json"), {
    data: {
      scenes: [
        {
          sceneId: 1,
          generationPrompt:
            "A vast empty Pacific ocean under harsh midday sun, photorealistic, vertical framing",
          assetType: "image",
        },
        {
          sceneId: 2,
          generationPrompt:
            "A satellite deorbit burn streaking into the atmosphere at night, vertical composition",
          assetType: "image",
        },
      ],
    },
  });

  writeJson(join(runDir, "artifacts/promptQA/v1.json"), {
    data: {
      status: "minor_revision",
      globalFeedback: "Scene 2 prompt lacks camera language",
      issues: ["scene 2 camera language missing"],
      revisionTarget: "prompts",
      sceneResults: [
        { sceneId: 1, verdict: "pass", feedback: "" },
        { sceneId: 2, verdict: "revise", feedback: "needs camera language" },
      ],
    },
    meta: {
      model: "glm-5.3",
      promptTokens: 4700,
      completionTokens: 130,
      durationMs: 2700,
    },
  });

  return runDir;
}

describe("harvestCases", () => {
  const dirs: string[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "qa-eval-"));
    dirs.push(root);
    return root;
  }

  it("harvests cases per gate with reconstructed state and references", () => {
    const root = makeRoot();
    fixtureRun(root);

    const cases = harvestCases({ runsDir: root });
    const byGate = Object.fromEntries(cases.map((c) => [c.gate, c]));

    expect(Object.keys(byGate).sort()).toEqual([
      "promptqa",
      "researchqa",
      "scriptqa",
    ]);

    const research = byGate.researchqa;
    expect(research.id).toBe("20260911-162616.811-point-nemo:researchqa:v1");
    expect(research.reference.status).toBe("major_revision");
    expect(research.reference.factVerdicts).toEqual({
      "fact-001": "keep",
      "fact-002": "revise",
    });
    expect(research.state).toContain("Point Nemo");
    expect(research.state).toContain("fact-001");
    expect(research.factIds).toEqual(["fact-001", "fact-002"]);
    expect(research.referenceMeta?.model).toBe("nemotron");
    expect(research.referenceMeta?.promptTokens).toBe(400);

    const script = byGate.scriptqa;
    expect(script.reference.status).toBe("approved");
    expect(script.state).toContain(
      "In the middle of the Pacific lies Point Nemo",
    );
    expect(script.state).toContain("Where is nowhere?");

    const prompt = byGate.promptqa;
    expect(prompt.reference.status).toBe("minor_revision");
    expect(prompt.reference.revisionTarget).toBe("prompts");
    expect(prompt.reference.sceneVerdicts).toEqual({ 1: "pass", 2: "revise" });
    expect(prompt.sceneIds).toEqual([1, 2]);
    expect(prompt.state).toContain("deorbit burn");
    expect(prompt.state).toContain("renderStyle");
    expect(prompt.referenceMeta?.model).toBe("glm-5.3");
  });

  it("honors the gates filter and returns empty for missing runs dir", () => {
    const root = makeRoot();
    fixtureRun(root);

    const onlyScript = harvestCases({ runsDir: root, gates: ["scriptqa"] });
    expect(onlyScript).toHaveLength(1);
    expect(onlyScript[0].gate).toBe("scriptqa");

    expect(harvestCases({ runsDir: join(root, "missing") })).toEqual([]);
  });

  it("skips gates without artifacts and runs without reference", () => {
    const root = makeRoot();
    const runDir = join(root, "empty-run");
    mkdirSync(join(runDir, "artifacts/promptQA"), { recursive: true });
    writeJson(join(runDir, "artifacts/promptQA/v1.json"), {
      data: { status: "retry", sceneResults: [] },
    });
    expect(harvestCases({ runsDir: root })).toEqual([]);
  });
});

describe("replayCases", () => {
  it("replays through an injected classifier and reports metrics", async () => {
    const root = mkdtempSync(join(tmpdir(), "qa-eval-replay-"));
    try {
      fixtureRun(root);
      const cases = harvestCases({ runsDir: root });
      expect(cases.length).toBeGreaterThan(0);

      const seenQuestions: string[][] = [];
      const classifier: Classifier = {
        provider: "fake",
        model: "fake-1",
        async classify(request): Promise<ClassificationResult> {
          seenQuestions.push(Object.keys(request.questions));
          const answers: ClassificationResult["answers"] = {};
          for (const name of Object.keys(request.questions)) {
            if (name.startsWith("scene_")) {
              answers[name] = {
                type: "choice",
                choice: "pass",
                confidence: 0.9,
                probabilities: { pass: 0.9, revise: 0.1 },
              };
            } else if (name.startsWith("fact_")) {
              answers[name] = {
                type: "choice",
                choice: "keep",
                confidence: 0.9,
                probabilities: { keep: 0.9, revise: 0.1 },
              };
            } else if (name === "revision_target") {
              answers[name] = {
                type: "choice",
                choice: "prompts",
                confidence: 0.95,
                probabilities: { prompts: 0.95, visual_plan: 0.05 },
              };
            } else {
              // Mirror each case's reference status so accuracy is perfect
              // for status; harness correctness check below uses that.
              const gate = request.questions[name];
              void gate;
              answers[name] = {
                type: "choice",
                choice: "approved",
                confidence: 0.99,
                probabilities: { approved: 0.99 },
              };
            }
          }
          return {
            answers,
            provider: "fake",
            model: "fake-1",
            usage: { inputTokens: 5, outputTokens: 1 },
            durationMs: 3,
          };
        },
      };

      const report = await replayCases(classifier, cases);
      expect(report.outcomes).toHaveLength(cases.length);
      expect(report.errors).toBe(0);
      expect(seenQuestions.length).toBe(cases.length);

      const researchOutcome = report.outcomes.find(
        (o) => o.gate === "researchqa",
      );
      expect(researchOutcome).toBeDefined();
      // fake always answers approved; reference is major_revision → wrong
      expect(researchOutcome?.pair.correct).toBe(false);
      expect(researchOutcome?.prediction.status).toBe("approved");

      const scriptOutcome = report.outcomes.find((o) => o.gate === "scriptqa");
      expect(scriptOutcome?.pair.correct).toBe(true);

      expect(report.metricsByGate.scriptqa?.accuracy).toBe(1);
      expect(report.metricsByGate.researchqa?.accuracy).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts classifier errors as wrong without throwing", async () => {
    const cases = [
      {
        id: "x:scriptqa:v1",
        gate: "scriptqa" as const,
        ns: "x",
        state: "state",
        reference: { status: "approved" },
      },
    ];
    const classifier: Classifier = {
      provider: "broken",
      model: "broken",
      classify: () => Promise.reject(new Error("boom")),
    };
    const report = await replayCases(classifier, cases);
    expect(report.errors).toBe(1);
    expect(report.outcomes[0].error).toBe("boom");
    expect(report.outcomes[0].pair.correct).toBe(false);
    expect(report.metricsByGate.scriptqa?.n).toBe(1);
  });
});

describe("gate question/prediction round-trip against harvest", () => {
  it("buildQuestions uses harvested scene/fact ids", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-eval-q-"));
    try {
      fixtureRun(root);
      const cases = harvestCases({ runsDir: root });
      const prompt = cases.find((c) => c.gate === "promptqa");
      expect(prompt).toBeDefined();
      const questions = buildQuestions(prompt!.gate, prompt!);
      expect(Object.keys(questions).sort()).toEqual([
        "revision_target",
        "scene_1",
        "scene_2",
        "status",
      ]);

      const research = cases.find((c) => c.gate === "researchqa");
      const researchQuestions = buildQuestions(research!.gate, research!);
      expect(Object.keys(researchQuestions).sort()).toEqual([
        "fact_fact-001",
        "fact_fact-002",
        "status",
      ]);

      const prediction = answersToPrediction("researchqa", {
        answers: {
          status: {
            type: "choice",
            choice: "major_revision",
            confidence: 0.91,
            probabilities: { major_revision: 0.91, approved: 0.09 },
          },
        },
        provider: "x",
        model: "y",
        usage: { inputTokens: 1, outputTokens: 0 },
        durationMs: 1,
      });
      expect(prediction.status).toBe(research!.reference.status);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
