import { describe, it, expect } from "@jest/globals";
import { checkScriptContract } from "../src/utils/script-contract.js";
import type { ContractIssue } from "../src/utils/script-contract.js";
import type { ProjectState } from "../src/types/index.js";

const FACTS = ["fact-001", "fact-002", "fact-003", "fact-004"].map((id) => ({
  id,
  fact: `${id} describes an approved research fact.`,
  confidence: "high",
}));

const NARRATIONS = [
  "A 25-foot wave crashed through Boston. The terrifying part is that it was not water.",
  "That wave rolled through the streets seconds later. Nobody had time to react.",
  "The same fault could slip tomorrow. The measured pressure is now three times larger.",
  "Here is why the wave still matters. Remember that wave from Boston, because we still cannot explain it.",
];

// The declared ending is the final sentence of the narration, and its opening
// word group echoes the hook ("wave", "Boston").
const ENDING_NARRATION =
  "Remember that wave from Boston, because we still cannot explain it.";

const PIVOT_SENTENCE = "The measured pressure is now three times larger.";

function planBeat(beatId: number, extra: Record<string, unknown> = {}) {
  return {
    beatId,
    purpose: `Purpose ${beatId}`,
    viewerQuestion: `Question ${beatId}?`,
    curiosityQuestion: `Curiosity ${beatId}?`,
    keyMessage: `Message ${beatId}.`,
    referencedFacts: [`fact-00${beatId}`],
    priority: "high",
    targetWords: 20,
    estimatedDurationSeconds: 7,
    ...extra,
  };
}

const LEDGER_BEATS = [
  planBeat(1, { opensLoop: "Why was the wave not water?" }),
  planBeat(2, { opensLoop: "How did nobody see it?", closesLoopFor: 1 }),
  planBeat(3, { opensLoop: "What would a slip release?", closesLoopFor: 2 }),
  planBeat(4, {
    opensLoop: "Whether the seafloor can hold.",
    closesLoopFor: 3,
  }),
];

function makeState(
  overrides: {
    planBeats?: Record<string, unknown>[];
    writerBeats?: { beatId: number; narration: string }[];
    endingType?: string;
    endingNarration?: string;
    pivotSentence?: string;
    pivotFactId?: string;
    pivotBeatId?: number;
    /** Lets a test disagree the writer's ending type from the plan's. */
    contentEndingType?: string;
  } = {},
): ProjectState {
  const writerBeats =
    overrides.writerBeats ??
    NARRATIONS.map((narration, i) => ({ beatId: i + 1, narration }));
  const endingType = overrides.endingType ?? "unresolved_mystery";
  return {
    project: { pillar: "Geography", topic: "Boston Molasses" },
    content: {
      script: "Full script",
      narration: writerBeats.map((b) => b.narration).join(" "),
      beats: writerBeats,
      ending: {
        type: overrides.contentEndingType ?? endingType,
        narration: overrides.endingNarration ?? ENDING_NARRATION,
      },
      retention: { pivotSentence: overrides.pivotSentence ?? PIVOT_SENTENCE },
    },
    research: { summary: "Summary.", facts: FACTS },
    storyPlan: {
      content: {
        title: "Title",
        hook: "A 25-foot wave crashed through Boston.",
      },
      storyType: "mystery",
      storySummary: "Summary arc.",
      storyBeats: overrides.planBeats ?? LEDGER_BEATS,
      audienceTrigger: {
        type: "shock",
        statement: "The measured pressure is three times what was predicted.",
        factIds: ["fact-003"],
      },
      endingType,
      retention: {
        pivotBeatId: overrides.pivotBeatId ?? 3,
        pivotFactId: overrides.pivotFactId,
      },
    },
    execution: { version: "0.1.0" },
  } as unknown as ProjectState;
}

function run(overrides: Parameters<typeof makeState>[0] = {}) {
  const state = makeState(overrides);
  return checkScriptContract(state, state.content?.narration ?? "");
}

function messages(issues: ContractIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

function hasMessage(issues: ContractIssue[], fragment: string): boolean {
  return messages(issues).some((m) => m.includes(fragment));
}

describe("checkScriptContract — blocking invariants", () => {
  it("accepts a contract that holds", () => {
    const result = run();
    expect(result.issues).toEqual([]);
    expect(result.derivation.hookSentence).toBe(
      "A 25-foot wave crashed through Boston.",
    );
    expect(result.derivation.pivotBeatId).toBe(3);
    expect(result.derivation.pivotWordPosition).toBeGreaterThan(0);
  });

  it("blocks when the ending type contradicts the plan", () => {
    const result = run({ contentEndingType: "twist" });
    expect(result.issues.some((i) => i.severity === "block")).toBe(true);
    expect(messages(result.issues)).toContain(
      'Retention contract: ending type is "twist" but the story plan required "unresolved_mystery"',
    );
  });

  it("blocks when the narration does not end on the declared ending", () => {
    const beats = [
      ...NARRATIONS.slice(0, 3).map((narration, i) => ({
        beatId: i + 1,
        narration,
      })),
      { beatId: 4, narration: "A completely different final line." },
    ];
    const result = run({ writerBeats: beats });
    expect(messages(result.issues)).toContain(
      "Retention contract: narration does not end with the declared narrative ending",
    );
  });

  it("blocks when the pivot sentence is absent from the narration", () => {
    const result = run({ pivotSentence: "A sentence that appears nowhere." });
    expect(messages(result.issues)).toContain(
      "Retention contract: pivot sentence is not present in the narration",
    );
  });

  it("blocks when the pivot sentence lands outside the pivot beat", () => {
    const result = run({ pivotBeatId: 1 });
    expect(
      hasMessage(result.issues, "pivot sentence must land inside pivot beat 1"),
    ).toBe(true);
  });

  it("blocks on a writer-beat mapping mismatch", () => {
    const result = run({
      writerBeats: [{ beatId: 1, narration: "Only one beat." }],
    });
    expect(messages(result.issues)).toContain(
      "Retention contract: expected 4 narration beats (one per story beat) but received 1",
    );
  });

  it("blocks on non-sequential writer beat ids", () => {
    const beats = [
      { beatId: 1, narration: NARRATIONS[0] },
      { beatId: 7, narration: NARRATIONS[1] },
    ];
    const result = run({ writerBeats: beats });
    expect(hasMessage(result.issues, "has beatId 7")).toBe(true);
  });
});

describe("checkScriptContract — pivotFactId tracing", () => {
  it("blocks when the pivot fact is not an approved fact", () => {
    const result = run({ pivotFactId: "fact-999" });
    expect(messages(result.issues)).toContain(
      'Retention contract: pivotFactId "fact-999" is not an approved research fact',
    );
  });

  it("blocks when the pivot beat does not reference the pivot fact", () => {
    const result = run({ pivotFactId: "fact-001" });
    expect(
      hasMessage(
        result.issues,
        'pivotFactId "fact-001" is not referenced by pivot beat 3',
      ),
    ).toBe(true);
  });

  it("skips the check entirely when the plan declares no pivot fact", () => {
    const result = run({ pivotFactId: undefined });
    expect(
      result.issues.filter((i) => i.message.includes("pivotFactId")),
    ).toEqual([]);
  });
});

describe("checkScriptContract — open-loop ledger", () => {
  it("warns when a non-final beat opens no loop", () => {
    const planBeats = LEDGER_BEATS.map((beat) =>
      beat.beatId === 2 ? { ...beat, opensLoop: undefined } : beat,
    );
    const result = run({ planBeats });
    expect(result.issues.every((i) => i.severity === "warn")).toBe(true);
    expect(messages(result.issues)).toContain(
      "Open-loop ledger: beat 2 opens no loop — every non-final beat must create one specific unanswered question",
    );
  });

  it("warns on an unannounced close", () => {
    const planBeats = LEDGER_BEATS.map((beat) =>
      beat.beatId === 2 ? { ...beat, closesLoopFor: 9 } : beat,
    );
    const result = run({ planBeats });
    expect(
      hasMessage(
        result.issues,
        "beat 2 closes a loop opened by beat 9, but no loop from that beat is still open",
      ),
    ).toBe(true);
  });

  it("warns when a loop opened before the final beat is never closed", () => {
    const planBeats = LEDGER_BEATS.map((beat) =>
      beat.beatId === 3 ? { ...beat, closesLoopFor: undefined } : beat,
    );
    const result = run({ planBeats });
    expect(messages(result.issues)).toContain(
      "Open-loop ledger: the loop opened by beat 2 is never closed by a later beat",
    );
  });

  it("warns when more than two loops are open at once", () => {
    const planBeats = [
      planBeat(1, { opensLoop: "Loop one." }),
      planBeat(2, { opensLoop: "Loop two." }),
      planBeat(3, { opensLoop: "Loop three." }),
      planBeat(4, { opensLoop: "Loop four.", closesLoopFor: 3 }),
    ];
    const result = run({ planBeats });
    expect(
      hasMessage(
        result.issues,
        "beat 3 leaves 3 loops unanswered at once (max 2)",
      ),
    ).toBe(true);
  });

  it("allows exactly one unclosed loop opened by the final beat", () => {
    const planBeats = [
      planBeat(1, { opensLoop: "Loop one." }),
      planBeat(2, { opensLoop: "Loop two.", closesLoopFor: 1 }),
      planBeat(3, { opensLoop: "Loop three.", closesLoopFor: 2 }),
      planBeat(4, {
        opensLoop: "The unanswered thread.",
        closesLoopFor: 3,
      }),
    ];
    const result = run({ planBeats });
    expect(result.issues).toEqual([]);
  });

  it("skips the ledger for cached plans that declare no loop fields", () => {
    const planBeats = [planBeat(1), planBeat(2), planBeat(3), planBeat(4)];
    const result = run({ planBeats });
    expect(
      messages(result.issues).some((m) => m.includes("Open-loop ledger")),
    ).toBe(false);
    expect(result.derivation.openLoops).toEqual([]);
  });
});

describe("checkScriptContract — beat boundaries", () => {
  it("derives the last/first sentence pairs ScriptQA joins on", () => {
    const result = run();
    expect(result.derivation.beatBoundaries).toEqual([
      {
        fromBeatId: 1,
        toBeatId: 2,
        previousLastSentence: "The terrifying part is that it was not water.",
        nextFirstSentence:
          "That wave rolled through the streets seconds later.",
      },
      {
        fromBeatId: 2,
        toBeatId: 3,
        previousLastSentence: "Nobody had time to react.",
        nextFirstSentence: "The same fault could slip tomorrow.",
      },
      {
        fromBeatId: 3,
        toBeatId: 4,
        previousLastSentence:
          "The measured pressure is now three times larger.",
        nextFirstSentence: "Here is why the wave still matters.",
      },
    ]);
  });
});

describe("checkScriptContract — hook payoff echo", () => {
  it("does not warn when the ending echoes the hook", () => {
    const result = run();
    expect(result.derivation.hookEndingEcho).toBe(true);
  });

  it("warns when the ending shares no content word with the hook", () => {
    const result = run({
      endingNarration: "The answer may already be under the city.",
    });
    expect(result.derivation.hookEndingEcho).toBe(false);
    expect(messages(result.issues)).toContain(
      "Hook payoff echo: the ending's opening words share no content word with the hook — the hook's promise is never visibly paid off",
    );
    expect(
      result.issues.find((i) => i.message.startsWith("Hook payoff echo"))
        ?.severity,
    ).toBe("warn");
  });

  it("ignores stopwords when testing for an echo", () => {
    const result = run({ endingNarration: "There was not much left of it." });
    expect(result.derivation.hookEndingEcho).toBe(false);
  });

  it("stays silent when there is no ending narration to compare", () => {
    const result = run({ endingNarration: "" });
    expect(result.derivation.hookEndingEcho).toBeNull();
  });
});
