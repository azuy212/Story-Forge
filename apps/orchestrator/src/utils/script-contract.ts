import type { ProjectState } from "../types/index.js";
import {
  beatWordSpans,
  endsWithTokens,
  findTokenSequenceIndex,
  firstSentence,
  splitSentences,
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
 * - beat boundaries       -> last/first sentence pairs ScriptQA joins on
 * - open loops            -> the planner's ledger, paired and audited here
 * - hook payoff echo      -> shared content words between hook and ending
 *
 * Issues carry a severity. `block` issues are structural failures the QA retry
 * loop must resolve; `warn` issues are advisory — ScriptQA surfaces them to the
 * reviewer (and to the writer through the revision feedback) without vetoing a
 * draft. New checks land as `warn` until eval runs show they do not churn.
 */

export interface BeatWordCount {
  beatId: number;
  words: number;
  targetWords?: number;
}

/** A beat join: the last sentence of one beat, the first of the next. */
export interface BeatBoundary {
  fromBeatId: number;
  toBeatId: number;
  previousLastSentence: string;
  nextFirstSentence: string;
}

/** One row of the planner's open-loop ledger. */
export interface LoopLedgerEntry {
  beatId: number;
  opensLoop?: string;
  closesLoopFor?: number | null;
}

export interface RetentionDerivation {
  hookSentence: string;
  pivotSentence: string;
  pivotWordPosition: number | null;
  pivotBeatId: number | null;
  pivotFactId: string | null;
  pivotBeatSpan: { startWord: number; endWord: number } | null;
  beatWordCounts: BeatWordCount[];
  wordsBeforePivotBeat: number;
  beatBoundaries: BeatBoundary[];
  openLoops: LoopLedgerEntry[];
  hookEndingEcho: boolean | null;
}

export type ContractSeverity = "warn" | "block";

export interface ContractIssue {
  message: string;
  severity: ContractSeverity;
}

export interface ScriptContractResult {
  issues: ContractIssue[];
  derivation: RetentionDerivation;
}

/**
 * Function words are too generic to carry a payoff echo: "that wave from
 * Boston" echoes a hook, "and that is why" does not.
 */
const STOPWORDS = new Set(
  (
    "a about after all also an and are as at be because been before being " +
    "between both but by came can come could did does each even every for " +
    "from get got had has have her here him his how into its just like made " +
    "make many may more most much must near need never new not now off one " +
    "only onto our out over own said same say says see she should since " +
    "some still such take than that the their them then there these they " +
    "this those through time too under until upon very want was way well " +
    "were what when where which while who will with within would year " +
    "years you your"
  ).split(" "),
);

/** Non-trivial content tokens — the only ones that can carry an echo. */
function contentTokens(text: string): string[] {
  return tokenizeText(text).filter(
    (token) => token.length >= 4 && !STOPWORDS.has(token),
  );
}

/** Loops allowed to be unanswered at once before the viewer loses the thread. */
const MAX_SIMULTANEOUS_LOOPS = 2;

function defaultDerivation(): RetentionDerivation {
  return {
    hookSentence: "",
    pivotSentence: "",
    pivotWordPosition: null,
    pivotBeatId: null,
    pivotFactId: null,
    pivotBeatSpan: null,
    beatWordCounts: [],
    wordsBeforePivotBeat: 0,
    beatBoundaries: [],
    openLoops: [],
    hookEndingEcho: null,
  };
}

/** True when a plan actually declares a loop ledger (legacy plans declare none). */
function declaresLedger(
  beats: { opensLoop?: string; closesLoopFor?: number | null }[],
): boolean {
  return beats.some(
    (beat) =>
      (typeof beat.opensLoop === "string" && beat.opensLoop.trim() !== "") ||
      (beat.closesLoopFor !== null && beat.closesLoopFor !== undefined),
  );
}

/**
 * Audit the planner's open-loop ledger: every non-final beat must open one,
 * at most `MAX_SIMULTANEOUS_LOOPS` may be unanswered at once, and every loop
 * except the final beat's own must be closed by a later beat.
 *
 * Failures are warn-severity: the ledger is a retention heuristic, and an
 * exhausted revision budget should not die on it.
 */
function checkOpenLoops(
  beats: {
    beatId: number;
    opensLoop?: string;
    closesLoopFor?: number | null;
  }[],
  issues: ContractIssue[],
): LoopLedgerEntry[] {
  const open: number[] = [];
  const entries: LoopLedgerEntry[] = beats.map((beat) => ({
    beatId: beat.beatId,
    opensLoop: beat.opensLoop,
    closesLoopFor: beat.closesLoopFor,
  }));

  beats.forEach((beat, index) => {
    const isFinalBeat = index === beats.length - 1;
    const closesFor = beat.closesLoopFor;

    if (closesFor !== null && closesFor !== undefined) {
      // Covers a self/later reference, a beat that never opened a loop, and a
      // beat whose loop an earlier beat already closed.
      const closesAnOpenLoop =
        closesFor < beat.beatId && open.includes(closesFor);
      if (!closesAnOpenLoop) {
        issues.push({
          message: `Open-loop ledger: beat ${beat.beatId} closes a loop opened by beat ${closesFor}, but no loop from that beat is still open`,
          severity: "warn",
        });
      } else {
        open.splice(open.indexOf(closesFor), 1);
      }
    }

    const opens =
      typeof beat.opensLoop === "string" ? beat.opensLoop.trim() : "";
    if (opens) {
      open.push(beat.beatId);
      if (open.length > MAX_SIMULTANEOUS_LOOPS) {
        issues.push({
          message: `Open-loop ledger: beat ${beat.beatId} leaves ${open.length} loops unanswered at once (max ${MAX_SIMULTANEOUS_LOOPS})`,
          severity: "warn",
        });
      }
    } else if (!isFinalBeat) {
      issues.push({
        message: `Open-loop ledger: beat ${beat.beatId} opens no loop — every non-final beat must create one specific unanswered question`,
        severity: "warn",
      });
    }
  });

  // Exactly one loop may stay open, and it must be the ending's own thread.
  const finalBeatId = beats.at(-1)?.beatId;
  const orphaned = open.filter((beatId) => beatId !== finalBeatId);
  for (const beatId of orphaned) {
    issues.push({
      message: `Open-loop ledger: the loop opened by beat ${beatId} is never closed by a later beat`,
      severity: "warn",
    });
  }

  return entries;
}

/**
 * Does the ending's opening word group echo the hook's? The hook is a promise
 * and the ending must visibly complete it — one shared content word is the
 * cheapest deterministic proxy for that.
 */
function detectHookEndingEcho(
  hookSentence: string,
  endingNarration: string | undefined,
): boolean | null {
  if (!hookSentence || !endingNarration) return null;
  const hookWords = contentTokens(hookSentence).slice(0, 6);
  const endingWords = contentTokens(firstSentence(endingNarration)).slice(0, 6);
  if (hookWords.length === 0 || endingWords.length === 0) return null;
  return endingWords.some((word) => hookWords.includes(word));
}

/** Derive the join pairs ScriptQA evaluates for narrative flow. */
function deriveBeatBoundaries(
  beats: { beatId: number; narration: string }[],
): BeatBoundary[] {
  const boundaries: BeatBoundary[] = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const previousSentences = splitSentences(beats[i].narration);
    const nextSentences = splitSentences(beats[i + 1].narration);
    boundaries.push({
      fromBeatId: beats[i].beatId,
      toBeatId: beats[i + 1].beatId,
      previousLastSentence: previousSentences.at(-1) ?? "",
      nextFirstSentence: nextSentences[0] ?? "",
    });
  }
  return boundaries;
}

export function checkScriptContract(
  state: ProjectState,
  narration: string,
): ScriptContractResult {
  const issues: ContractIssue[] = [];
  const derivation = defaultDerivation();

  const storyPlan = state.storyPlan;
  const content = state.content;
  if (!storyPlan?.storyBeats?.length) return { issues, derivation };

  const narrationTokens = tokenizeText(narration);
  derivation.hookSentence = firstSentence(narration);

  const block = (message: string): void => {
    issues.push({ message, severity: "block" });
  };
  const warn = (message: string): void => {
    issues.push({ message, severity: "warn" });
  };

  const endingType = storyPlan.endingType;
  if (
    endingType &&
    content?.ending?.type &&
    endingType !== content.ending.type
  ) {
    block(
      `Retention contract: ending type is "${content.ending.type}" but the story plan required "${endingType}"`,
    );
  }

  if (
    content?.ending?.narration &&
    !endsWithTokens(narration, content.ending.narration)
  ) {
    block(
      "Retention contract: narration does not end with the declared narrative ending",
    );
  }

  const pivotBeatId = storyPlan.retention?.pivotBeatId ?? null;
  derivation.pivotBeatId = pivotBeatId;

  const pivotFactId = storyPlan.retention?.pivotFactId ?? null;
  derivation.pivotFactId = pivotFactId;

  const writerBeats = content?.beats;
  const pivotTokens = tokenizeText(content?.retention?.pivotSentence ?? "");
  const pivotSentence = content?.retention?.pivotSentence ?? "";
  derivation.pivotSentence = pivotSentence;

  if (pivotTokens.length > 0) {
    const position = findTokenSequenceIndex(narrationTokens, pivotTokens);
    derivation.pivotWordPosition = position >= 0 ? position : null;
    if (position < 0) {
      block(
        "Retention contract: pivot sentence is not present in the narration",
      );
    }
  }

  // The pivot must escalate on the fact the planner named for it. Optional
  // field, so a plan without one simply skips this check.
  if (pivotFactId) {
    const approvedFactIds = new Set(
      (state.research?.facts ?? []).map((fact) => fact.id),
    );
    const referencingBeats = storyPlan.storyBeats.filter((beat) =>
      beat.referencedFacts.includes(pivotFactId),
    );
    if (approvedFactIds.size > 0 && !approvedFactIds.has(pivotFactId)) {
      block(
        `Retention contract: pivotFactId "${pivotFactId}" is not an approved research fact`,
      );
    } else if (referencingBeats.length === 0) {
      block(
        `Retention contract: pivotFactId "${pivotFactId}" is not referenced by any story beat`,
      );
    } else if (
      pivotBeatId !== null &&
      !referencingBeats.some((beat) => beat.beatId === pivotBeatId)
    ) {
      block(
        `Retention contract: pivotFactId "${pivotFactId}" is not referenced by pivot beat ${pivotBeatId}`,
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
      block(
        `Retention contract: expected ${storyPlan.storyBeats.length} narration beats (one per story beat) but received ${writerBeats.length}`,
      );
    }

    writerBeats.forEach((beat, index) => {
      const expectedId = index + 1;
      if (beat.beatId !== expectedId) {
        block(
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
        block(
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

    // Beat joins are the one place the narration is most likely to restart:
    // derive the exact pairs so QA judges boundaries instead of a flat block.
    derivation.beatBoundaries = deriveBeatBoundaries(writerBeats);
  }

  if (declaresLedger(storyPlan.storyBeats)) {
    derivation.openLoops = checkOpenLoops(storyPlan.storyBeats, issues);
  }

  derivation.hookEndingEcho = detectHookEndingEcho(
    derivation.hookSentence,
    content?.ending?.narration,
  );
  if (derivation.hookEndingEcho === false) {
    warn(
      "Hook payoff echo: the ending's opening words share no content word with the hook — the hook's promise is never visibly paid off",
    );
  }

  return { issues, derivation };
}
