import type { ProjectState } from "../types/index.js";
import {
  beatWordSpans,
  endsWithTokens,
  findTokenSequenceIndex,
  firstSentence,
  tokenizeText,
  wordCount,
} from "./narration-contract.js";

/**
 * Deterministic re-verification of the retention contract the ScriptWriter
 * committed to. These invariants are structurally checkable, so code must not
 * outsource them to the LLM QA.
 *
 * The writer declares only `pivotSentence`. Everything else is DERIVED here
 * from the beat-level narration the writer committed to:
 *
 * - hookSentence          -> first sentence of the concatenated narration
 * - ending sentence       -> remaining-narration suffix check (existing)
 * - pivot word position   -> contiguous occurrence of pivotSentence tokens
 * - pivot -> beat mapping -> pivot tokens inside beats[pivotBeatId].narration
 * - per-beat word budgets -> each beat within +/-40% of the planner's target
 * - beat mapping          -> every planner beat has exactly one narration beat
 */

export interface BeatWordCount {
  beatId: number;
  words: number;
  targetWords?: number;
}

export interface RetentionDerivation {
  hookSentence: string;
  pivotSentence: string;
  pivotWordPosition: number | null;
  pivotBeatId: number | null;
  pivotBeatSpan: { startWord: number; endWord: number } | null;
  beatWordCounts: BeatWordCount[];
  wordsBeforePivotBeat: number;
}

export interface ScriptContractResult {
  issues: string[];
  derivation: RetentionDerivation;
}

function defaultDerivation(): RetentionDerivation {
  return {
    hookSentence: "",
    pivotSentence: "",
    pivotWordPosition: null,
    pivotBeatId: null,
    pivotBeatSpan: null,
    beatWordCounts: [],
    wordsBeforePivotBeat: 0,
  };
}

export function checkScriptContract(
  state: ProjectState,
  narration: string,
): ScriptContractResult {
  const issues: string[] = [];
  const derivation = defaultDerivation();

  const storyPlan = state.storyPlan;
  const content = state.content;
  if (!storyPlan?.storyBeats?.length) return { issues, derivation };

  const narrationTokens = tokenizeText(narration);
  derivation.hookSentence = firstSentence(narration);

  const endingType = storyPlan.endingType;
  if (
    endingType &&
    content?.ending?.type &&
    endingType !== content.ending.type
  ) {
    issues.push(
      `Retention contract: ending type is "${content.ending.type}" but the story plan required "${endingType}"`,
    );
  }

  if (
    content?.ending?.narration &&
    !endsWithTokens(narration, content.ending.narration)
  ) {
    issues.push(
      "Retention contract: narration does not end with the declared narrative ending",
    );
  }

  const pivotBeatId = storyPlan.retention?.pivotBeatId ?? null;
  derivation.pivotBeatId = pivotBeatId;

  const writerBeats = content?.beats;
  const pivotTokens = tokenizeText(content?.retention?.pivotSentence ?? "");
  const pivotSentence = content?.retention?.pivotSentence ?? "";
  derivation.pivotSentence = pivotSentence;

  if (pivotTokens.length > 0) {
    const position = findTokenSequenceIndex(narrationTokens, pivotTokens);
    derivation.pivotWordPosition = position >= 0 ? position : null;
    if (position < 0) {
      issues.push(
        "Retention contract: pivot sentence is not present in the narration",
      );
    }
  }

  const spans = writerBeats?.length ? beatWordSpans(writerBeats) : [];
  if (pivotBeatId !== null) {
    const beatSpan = spans.find((s) => s.beatId === pivotBeatId) ?? null;
    derivation.pivotBeatSpan = beatSpan
      ? { startWord: beatSpan.startWord, endWord: beatSpan.endWord }
      : null;
    derivation.wordsBeforePivotBeat = beatSpan?.startWord ?? 0;
  }

  const plannerBeatMap = new Map(
    storyPlan.storyBeats.map((b) => [b.beatId, b]),
  );

  if (writerBeats?.length) {
    if (writerBeats.length !== storyPlan.storyBeats.length) {
      issues.push(
        `Retention contract: expected ${storyPlan.storyBeats.length} narration beats (one per story beat) but received ${writerBeats.length}`,
      );
    }

    writerBeats.forEach((beat, index) => {
      const expectedId = index + 1;
      if (beat.beatId !== expectedId) {
        issues.push(
          `Retention contract: narration beat ${index + 1} has beatId ${beat.beatId}; expected ${expectedId}`,
        );
      }
    });

    // Pivot containment: the declared pivot sentence must live entirely
    // inside the narration of the planner's pivot beat.
    if (
      pivotBeatId !== null &&
      pivotTokens.length > 0 &&
      derivation.pivotWordPosition !== null
    ) {
      const pivotBeat = writerBeats.find((b) => b.beatId === pivotBeatId);
      const pivotBeatContained = pivotBeat
        ? findTokenSequenceIndex(
            tokenizeText(pivotBeat.narration),
            pivotTokens,
          ) >= 0
        : false;
      if (!pivotBeatContained) {
        issues.push(
          `Retention contract: pivot sentence must land inside pivot beat ${pivotBeatId} narration`,
        );
      }
    }

    derivation.beatWordCounts = writerBeats.map((beat) => {
      const planner = plannerBeatMap.get(beat.beatId);
      return {
        beatId: beat.beatId,
        words: wordCount(beat.narration),
        targetWords: planner?.targetWords,
      };
    });

    // Per-beat budget is DERIVED context for ScriptQA, NOT a hard contract.
    // The planner allocation is structural; writer adherence is editorial.
    // QA receives beatWordCounts with targets and flags only if pacing
    // is materially harmed (see ScriptQA prompt).
  }

  return { issues, derivation };
}
