import { readFile } from "node:fs/promises";
import { PipelineError } from "../utils/errors.js";
import { atomicWriteFile } from "./atomic.js";
import type { JobPaths } from "./paths.js";
import type { StoryClaim } from "./types.js";

/**
 * Human claim checklist (episode-review follow-up).
 *
 * Every story is written from model knowledge (`groundingSource:
 * "model-knowledge"`), so the ledger is the only record of what the narration
 * asserts. `claims-checklist.md` turns that ledger into something a person can
 * actually work through: one unchecked box per claim, its status, a suggested
 * search query, and an explicit `needsSource` marker for claims about what a
 * named person later did — the class of claim that is most often invented by
 * storytelling drift.
 *
 * `--confirm-claims` refuses to render until every box is ticked.
 */

/**
 * A claim about what a NAMED person did later needs a source: the narrator has
 * no reason to know the sequel from the story itself, and model knowledge is
 * exactly where a plausible-sounding "later became governor" comes from.
 * Pronouns ("he later…") and unnamed groups ("the mutineers later…") do not
 * match: without a name there is nothing a search query can resolve.
 */
const NAMED_PERSON_LATER =
  /\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2}),?\s+later\b/gu;
/** A capitalized word at the start of a claim is not enough: pronouns and
 * determiners ("He", "The mutineers") are not a named person a search can
 * resolve. */
const NOT_A_NAMED_PERSON = /^(he|she|it|they|the|we|i)$/i;

export function claimNeedsSource(claim: string): boolean {
  for (const match of claim.matchAll(NAMED_PERSON_LATER)) {
    const firstWord = match[1]?.split(/\s+/)[0] ?? "";
    if (NOT_A_NAMED_PERSON.test(firstWord)) continue;
    return true;
  }
  return false;
}

/**
 * A deterministic suggested query. The claim itself is the most faithful
 * phrase to search, so only whitespace, quote characters and the final period
 * are normalized; a very long claim is truncated at a word boundary.
 */
export function suggestClaimQuery(claim: string): string {
  const clean = claim
    .replace(/\s+/g, " ")
    .replace(/[`"“”]/g, "")
    .trim()
    .replace(/[.!?]+$/, "");
  if (clean.length <= 140) return clean;
  const cut = clean.slice(0, 140);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 80 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** Attach the derived fields to every claim (overriding any model-provided ones). */
export function annotateClaims(claims: StoryClaim[]): StoryClaim[] {
  return claims.map((claim) => ({
    ...claim,
    needsSource: claimNeedsSource(claim.claim),
    searchQuery: suggestClaimQuery(claim.claim),
  }));
}

export interface ClaimsChecklistProgress {
  total: number;
  checked: number;
  unchecked: number;
}

/** The checkbox line this module writes (and reads back). */
export const CLAIM_CHECKBOX = "- [ ] Checked";

export function buildClaimsChecklist(claims: StoryClaim[]): string {
  const lines = [
    "# Claims checklist",
    "",
    "This story was written from model knowledge: nothing here has been checked",
    "against an outside source. Tick a box only after you have checked that claim",
    "against a source. Rendering with `--confirm-claims` refuses while any box is",
    "still unticked.",
    "",
  ];
  if (claims.length === 0) {
    lines.push("_The story returned no claims._", "");
    return lines.join("\n");
  }

  claims.forEach((claim, index) => {
    const needsSource = Boolean(
      claim.needsSource ?? claimNeedsSource(claim.claim),
    );
    const query = claim.searchQuery ?? suggestClaimQuery(claim.claim);
    lines.push(
      `## ${index + 1}. ${claim.claim.trim()}`,
      "",
      `- Status: \`${claim.status}\``,
      `- needsSource: ${needsSource}`,
      `- Suggested search: \`${query}\``,
      CLAIM_CHECKBOX,
      "",
    );
  });
  return lines.join("\n");
}

const CHECKBOX = /^\s*-\s*\[([ xX])\]\s*(.*)$/gm;

export function claimsChecklistProgress(
  markdown: string,
): ClaimsChecklistProgress {
  let total = 0;
  let checked = 0;
  for (const match of markdown.matchAll(CHECKBOX)) {
    total += 1;
    if (match[1].toLowerCase() === "x") checked += 1;
  }
  return { total, checked, unchecked: total - checked };
}

/**
 * Write the checklist only when it is missing. A resume from an older job
 * (written before this artifact existed) gets one, without overwriting the
 * ticks a reviewer already made.
 */
export async function ensureClaimsChecklist(
  paths: JobPaths,
  claims: StoryClaim[],
): Promise<void> {
  try {
    await readFile(paths.claimsChecklist, "utf8");
    return;
  } catch {
    // Missing: write the current ledger below.
  }
  await atomicWriteFile(
    paths.claimsChecklist,
    buildClaimsChecklist(claims),
  );
}

/**
 * Rendering gate for `--confirm-claims`: every checkbox in the checklist must
 * be ticked. A missing checklist is an error too — "no checklist" is not the
 * same as "all claims confirmed".
 */
export async function assertClaimsConfirmed(
  paths: JobPaths,
): Promise<void> {
  let markdown: string;
  try {
    markdown = await readFile(paths.claimsChecklist, "utf8");
  } catch {
    throw new PipelineError(
      `Cannot confirm claims: ${paths.claimsChecklist} is missing. Run S2_story to write it, tick every claim, then render.`,
      "STORY_CLAIMS_UNCONFIRMED",
    );
  }

  const progress = claimsChecklistProgress(markdown);
  if (progress.total === 0) {
    throw new PipelineError(
      `Cannot confirm claims: ${paths.claimsChecklist} has no claim checkboxes. Regenerate the checklist from the story before rendering.`,
      "STORY_CLAIMS_UNCONFIRMED",
    );
  }
  if (progress.unchecked > 0) {
    throw new PipelineError(
      `Cannot render: ${progress.unchecked} of ${progress.total} claim(s) in ${paths.claimsChecklist} are still unticked. Check each claim against a source, tick its box, then rerun with --confirm-claims.`,
      "STORY_CLAIMS_UNCONFIRMED",
    );
  }
}
