# Prompt Retention Improvement Plan

Goal: strengthen viewer retention in generated videos along three axes —
**(A) the opening hook**, **(B) the mid-video scroll-away zone**, and
**(C) linear flow so scenes feel like one continuous story, not disconnected
jumps**.

> **Rev. 3 — post re-verification corrections.**
> - **Path typos fixed:** `nodes/visual-director.node.ts` (B4, C5) and `src/nodes/script-qa.node.ts`
>   (C6) → correct prefix is `apps/orchestrator/src/agents/…` (`src/nodes/` does not exist).
> - **B1 internal inconsistency resolved:** step 2's unclosed-loop rule now states the design-tension
>   mitigation wins — exactly one unclosed loop for *any* `endingType`, superseding the earlier
>   `{unresolved_mystery, open_question}` restriction.

All changes are prompt-file edits plus deterministic-check additions in
`apps/orchestrator/src/utils/script-contract.ts`. **No graph topology changes — but note (Rev. 2):
B4 and C5 require VisualDirector *node* variable additions, not just prompt text** (see items), and
item #4 of the rollout must budget for **new** contract tests: none exist today (no file in
`apps/orchestrator/tests` imports `checkScriptContract`).

> **Rev. 2 — post final-review corrections.** Validated against the working tree:
> - **Audit overstatement fixed:** the sag zone is not empty — writer L19 + planner curiosity-arc
>   rules already provide per-beat `curiosityQuestion`. The gap is that no ledger *tracks* them.
> - **VD has no story context:** `visual-director.node.ts` (~L497-518) passes only narration,
>   ending, trigger, facts — **not** storyBeats or pivot. B4 and C5 reclassified as node+prompt.
> - **Severity channel needed:** ScriptQA treats any `checkScriptContract` issue as
>   `major_revision`; C6(2)'s warn-only rollout requires a new `severity` field on contract issues.
> - **Cache compatibility:** planner schema validates cached artifacts on resume — B1's new fields
>   must be **optional** or they invalidate all in-flight cached plans.
> - **B3:** use a dedicated `pivotFactId`, not an overload of `keyMessage` (which rules L65/L102
>   already use for fact-based prose + hook-trigger documentation).
> - **Rollout:** `PromptPaths` hardcodes `v1.md` (`models/prompt-paths.ts`) — dropping in `v2.md`
>   does **not** switch versions; A/B needs a PromptPaths/env change.

## Current State (audited)

| Retention lever | Where it lives | Status |
| --- | --- | --- |
| Hook = first spoken sentence, fact-first, banned openers | planner v1.md L39-41, writer v1.md L10-16, QA check 2, editorial-guidelines | ✅ Strong |
| Trigger chosen from research before hook written | planner v1.md L51-65, QA check 15 | ✅ Strong |
| Mid-script pivot (position math + inside pivotBeatId) | writer v1.md L53-77, contract derivation, QA check 12 | ✅ Strong |
| Ending leaves a hook, type-matched | planner endingType, writer, QA checks 11/14 | ✅ Strong |
| **Sag zone between hook and pivot (~5-30s)** | per-beat `curiosityQuestion` prose exists (writer L19, planner arc rules) but nothing tracks payoffs | ❌ Gap B1 (untracked, not absent) |
| **Open loops / payoffs tracked across beats** | per-beat `curiosityQuestion` prose only | ❌ Gap B1 |
| **Beat-to-beat narration bridges** | QA check 5 reviews flat concatenated narration | ❌ Gap C1 |
| **Visual continuity enforcement** | `visualAnchor` optional (VD v1.md L~160), image-prompt-generator honors it, PromptQA check 1 vague | ❌ Gap C2 |
| **Transition semantics** | enum only (cut/fade/cross-dissolve/zoom/match-cut), no selection rules | ❌ Gap C3 |
| **Hook promise → payoff line carried into visuals** | VD rule 12 + PromptQA check 7 exist, but no explicit "payoff line" contract | ⚠️ Partial |

---

## A. Hook Improvements (first 0-3 seconds)

### A1. Add pattern library + anti-cliche list to ScriptPlanner hook rules
**File:** `apps/orchestrator/prompts/script-planner/v1.md` (Hook first section, ~L39)

The planner picks the trigger *type* but gives the hook *sentence shape* no
guidance. Add a short menu of proven opener patterns, each required to be
built from an approved fact:

- Cold-open contradiction: "Everyone thinks X. The data says Y."
- Stakes drop: "If this [fault/signal/decision] slips, [consequence] in [timeframe]."
- Scale-before-context: state the number first, explain after.
- Impossible-object tease: "There is a place/thing where [violation of expectation]."
- Delayed-payoff question: pose the exact question the video answers at the end.

And an explicit ban list beyond the existing one: rhetorical "Have you ever
wondered…", "What if I told you…", "This will change everything", second-person
guilt openers ("You've been doing X wrong"). These are retention-negative in
documentary format and currently unpoliced.

**Verification:** planner output hooks matching banned patterns fail ScriptQA
check 2 (extend its flag list, see A2).

### A2. Mirror the ban list into ScriptQA check 2
**File:** `apps/orchestrator/prompts/script-qa/v1.md` (CHECK 2)

ScriptQA currently bans only date/location/"In [year]"/"Scientists
discovered"/"Today we're going to". Add the A1 cliche patterns to the same
flag list so writer and QA stay symmetric (the prompts explicitly promise
this symmetry: "you will be re-issued if any is missing").

### A3. Contract-level determinism for hook-vs-trigger consistency
**Files:** `apps/orchestrator/src/utils/script-contract.ts`, `src/schemas/content.ts`, `src/agents/script-qa.node.ts` (template vars)

Today the derived `hookSentence` is verified as *first sentence* but never
compared against the planner's `audienceTrigger.statement`. Cheap addition:
pass both into ScriptQA's context block (already has a DETERMINISTIC ANCHORS
section) and add one instruction: "Flag ONLY if the hook sentence clearly fails
to land the trigger statement's fact." This closes the loop without new schema
fields or fuzzy string matching in code.

---

## B. The Middle — Surviving the Scroll-Away Zone

### B1. Open-Loop Ledger (biggest structural change)
**Files:** `script-planner/v1.md`, `script-writer/v1.md`, `script-qa/v1.md`,
`src/schemas/script-planner-output.ts`, `src/schemas/content.ts`,
`src/utils/script-contract.ts` (**new tests required — none exist today for this module**)

The sag zone (after the hook, before the pivot, ~5-30s in shorts) currently
relies on each beat's `curiosityQuestion` prose with no tracking. Formalize it:

0. **Cache compatibility (Rev. 2):** `scriptPlannerOutputSchema` validates cached planner
   artifacts on resume, so `opensLoop`/`closesLoopFor` must be added as **optional** schema
   fields; enforce the cross-beat pairing rules deterministically in `script-contract.ts`
   instead of via required-schema validation. (Alternative: version the schema and bump.)
1. **Planner** adds to each non-final beat:
   - `opensLoop`: one-line unresolved question/tension this beat creates
     (must differ from `curiosityQuestion` boilerplate; specific and answerable).
   - `closesLoopFor`: the beatId of an earlier beat whose loop this beat pays
     off (nullable; beat 1 = null).
2. **Deterministic validation in `script-contract.ts`** (fail-closed, mirrors
   existing pivot/beat checks):
   - Every non-final beat except the last must `opensLoop` something.
   - Every opened loop must be closed by some later beat, OR be explicitly the
     ending's unresolved thread — **exactly one unclosed loop allowed for *any*
     `endingType`, mapped to the final beat** (Rev. 3: this supersedes the earlier
     narrower rule that restricted unclosed loops to `unresolved_mystery`/
     `open_question`; see Design Tension below — the writer rule lets any ending
     type leave a hook, so the permissive version wins).
   - At most 2 loops open simultaneously (prevents confusion pile-up).
3. **Writer** must make each loop's closure audible: the closing beat's first
   sentence uses callback language ("Remember…", "That [thing] from earlier…",
   "Here's why…") tying back to the opening phrasing.
4. **ScriptQA** gains check: "PAYOFF LINKAGE — for each planned loop pair, does
   the closing narration visibly answer the opened question? Flag orphaned
   opens and unannounced closes."

Why this fixes the middle: viewers stay when an *explicitly opened* question
demands its answer, and callbacks make progress legible instead of feeling
like a lecture treadmill.

**Design tension (Rev. 2 — highest churn risk in this plan, correctly ranked #4):**
the constraint set above (every non-final beat opens + ≤2 simultaneous + every loop closed
by a later beat + singular `closesLoopFor`) forces a near-fully-chained structure on 6–10
beat shorts, and each closure also demands audible callback language plus a new QA check.
The "small deterministic-check additions" framing undersells this. Mitigations:
- Ship step 2 initially as **warn-severity** (requires the severity channel described in
  C6(2)) and promote to blocking only after eval runs show acceptable revision rates.
- Do **not** restrict unclosed loops to only `unresolved_mystery`/`open_question` — the
  writer rule allows any ending type to leave a hook; allow one unclosed loop for any
  `endingType` (still exactly one), or relax to "final beat may leave ≤1 loop open".
  **(Rev. 3: this mitigation is now authoritative — B1 step 2 has been rewritten to match.)**
- Consider seeding the ledger from existing per-beat `curiosityQuestion` values so the
  planner isn't asked to invent a second parallel structure.

### B2. Retention valleys between hook and pivot
**File:** `script-writer/v1.md` (Retention architecture section)

The pivot rule targets ~45%/≤30s, but the beats *before* it get no micro-hooks.
Add a rule: every beat between the hook and the pivot must contain one
forward-pointing device drawn from:

- stakes escalation ("and that was only the beginning of…" — honest version:
  next fact is strictly larger/severe/consequential, verified against research),
- partial reveal ("the explanation involves X — but X alone doesn't account for
  Y"),
- mini-refutation of the previous beat's implied conclusion.

Prohibit pure exposition in these beats (already prohibited at escalation
beats; extend to all pre-pivot beats). Keep the trigger-honesty guardrails:
device must ride on a research fact, never manufactured suspense.

### B3. Pivot strength audit against the full fact set
**Files:** `script-planner/v1.md` (retention.pivotBeatId rules),
`src/schemas/script-planner-output.ts` (new optional `retention.pivotFactId`)

Currently `pivotBeatId` = "strongest escalation near the cliff" but the planner
never justifies the choice. Require the planner to set a **dedicated new field**
`retention.pivotFactId` naming the specific approved fact ID powering the pivot,
and require that fact's classification/confidence to support the escalation claim.
ScriptQA check 12 already judges pivot effectiveness — give it the fact ID to
trace against (single extra template var).

**Rev. 2 correction:** do *not* overload `keyMessage` for this. Planner rule 11 defines
`keyMessage` as fact-based prose, and L65/L102 already use it to carry hook-trigger
documentation — requiring it to also name a fact ID collides with those consumers. A
separate `pivotFactId` (optional in schema for cache compat, same rationale as B1) keeps
existing consumers intact; cross-field validity (`pivotFactId` ∈ approved facts, beat it
names == `pivotBeatId`) is enforced deterministically in `script-contract.ts`.

### B4. Carry the pivot through the visuals
**Files:** `visual-director/v1.md` **+ `apps/orchestrator/src/agents/visual-director.node.ts`
(node change)**

**Rev. 2 correction — reclassified from prompt-only.** The original claim that "the pivot
sentence is passed to the VD (writer→contract→state)" is **false**: the pivot lives in
`state.content.retention.pivotSentence` and `storyPlan.retention.pivotBeatId`, but the VD
node (~L497-518) forwards only narration, ending, trigger, and facts — no storyBeats, no
pivot. Prerequisite step:
- [ ] Add `pivotSentence` (and `pivotBeatId`) to the template variables the VD node builds.

Then add the prompt rule itself:
"Identify the scene containing the pivot sentence. That scene gets emphasis
high and the strongest available visual contrast (scale shift, expected-vs-
actual split, or camera-motion reversal). It must NOT share its visualAnchor
with the following scene unchanged — the pivot is the sanctioned moment to
break the anchor." Without this, audio pivots while the visual stream stays
flat — the exact moment muted-feed scrollers leave.

---

## C. Linear Flow — Scenes Should Never Feel Like Restarts

### C1. Beat-boundary bridge check (fixes ScriptQA's blind spot)
**Files:** `script-writer/v1.md`, `script-qa/v1.md`, optionally
`script-contract.ts`

Choppiness happens at joins, but QA check 5 reviews one flat concatenation and
never inspects boundaries. Two changes:

1. **Writer rule:** "Each beat's FIRST sentence must connect explicitly to the
   previous beat's LAST sentence using one of: shared referent ('that ship',
   'this gap'), temporal bridge ('seconds later', 'for the next three years'),
   causal bridge ('which is why', 'because of this'), or contrast bridge
   ('but there was a problem'). Beat 1 is exempt (it is the hook)."
2. **QA input formatting:** pass beats as numbered sections (they already are
   in state) and instruct QA to evaluate the join sentences pairwise.
3. Optional deterministic assist in `script-contract.ts`: derive boundary
   pairs (last sentence of beat N, first of beat N+1) and include them under
   DETERMINISTIC ANCHORS so QA focuses precisely on joins.

### C2. Make `visualAnchor` mandatory for narrative scenes + QA check
**Files:** `visual-director/v1.md`, `prompt-qa/v1.md`,
`src/schemas/visual-director-output.ts` (if made required)

`visualAnchor` exists and the image-prompt-generator already promises
cross-scene identity continuity, but it is optional and unchecked:

1. VD rule: "Every `sceneRole: narrative` scene must declare a `visualAnchor`.
   Adjacent scenes covering the same mechanism/system/comparison MUST reuse
   the identical anchor string. Changing anchors between adjacent narrative
   scenes requires a transition other than `cut` (see C3)."
2. PromptQA check 1 (CONSISTENCY) becomes concrete: "Adjacent scenes sharing a
   visualAnchor must produce prompts describing the same subject, layout, and
   framing with incremental change only (added arrow, highlighted region). Flag
   any anchor change between adjacent narrative scenes without a declared
   reason."
3. Schema option: keep field optional for b-roll compatibility, enforce via
   prompt + QA rather than hard schema break (lower risk; revisit if models
   comply).

### C3. Transition semantics table
**File:** `visual-director/v1.md` (transition enum section)

Enum without rules yields arbitrary choices. Add selection rules:

- `cut` — default within one anchor/idea; use freely between sentences of the
  same visual.
- `match-cut` — allowed ONLY when consecutive scenes share a shape, position,
  or motion correspondence; state the correspondence in `visualDescription` of
  both scenes.
- `cross-dissolve` / `fade` — reserved for time jumps, location changes, or
  beat-boundary mood shifts; never mid-explanation.
- `zoom` — emphasis reveals only.
- Hard cap: max 2 non-cut transitions per 60s (prevents music-video feel that
  contradicts documentary tone).

### C4. Emotional arc adjacency constraint
**File:** `visual-director/v1.md` (rule 9, emotional pacing)

Rule 9 already asks for a build (mystery → tension → discovery → awe → payoff →
reflection) but permits random jumps. Add: "emotionalBeat may advance at most
one step forward or hold steady between adjacent scenes; regressions allowed
only at beat boundaries (new story beat) and must be motivated in `sceneGoal`."

### C5. Scene-to-beat traceability
**Files:** `visual-director/v1.md`, `prompt-qa/v1.md` **+ `apps/orchestrator/src/agents/visual-director.node.ts`
(node change — same prerequisite family as B4)**

**Rev. 2 correction — reclassified from prompt-only.** The VD node never receives the
planner's story beats, so it cannot map scenes→beats. Prerequisite: forward `storyBeats`
(id + keyMessage per beat) into the VD template variables alongside the B4 pivot vars.

Then: scenes merge beats today with no record. Add optional `sourceBeatIds` per
scene; PromptQA gets: "every story beat must appear in at least one scene's
sourceBeatIds; flag dropped beats." Prevents silent content loss during
merging — a common cause of "wait, what happened?" mid-video. (Optional field on the
VD output schema keeps cached visual plans valid on resume, per the B1 cache rationale.)

### C6. Hook-promise payoff line through composition
**Files:** `script-planner/v1.md` (content.hook contract), `script-writer/v1.md`,
`visual-director/v1.md`, `src/utils/script-contract.ts` + `src/agents/script-qa.node.ts`
(severity channel)

Make the hook an explicit promise with a named payoff:

1. Planner: `hook` field guidance adds — "phrase the hook so the video's
   ending visibly completes it (question→answer, belief→correction, threat→
   resolution/outcome)."
2. Writer: the ending's first word-group must lexically echo the hook (echo
   detection possible in `script-contract.ts` via shared content-word overlap ≥
   1 non-trivial token). **Rev. 2 prerequisite:** "warn-only at first, promote to
   blocking" is not implementable as written — `checkScriptContract` returns a flat
   `string[]` and `script-qa.node.ts` (~L168-178) treats *any* issue as
   `major_revision`. First add a severity channel: change issues to
   `{ message: string; severity: "warn" | "block" }[]`, have ScriptQA block only on
   `severity: "block"` and surface warns in its notes; then register the echo check
   as `warn`. This refactor also unblocks B1's staged rollout (same channel).
3. VD: final scene must reuse the Scene-1 `visualAnchor` (bookend shot) unless
   `endingType` is `twist` — the audience recognizes "we're back at the start,
   but now it means something different." This is the single strongest
   linearity signal available in short form.

---

## Implementation Order & Risk

(Rev. 2: B4/C5 reclassified — they are **node + prompt** changes, not prompt-only; the
severity-channel refactor is a new prerequisite tier.)

| Order | Items | Type | Risk |
| --- | --- | --- | --- |
| 1 | A1, A2, A3, B2, B3 (prompt text) | prompt text only | Low — additive rules; watch revision-loop rate |
| 1.5 | C6(2) severity channel (`{message, severity}[]` in script-contract.ts + script-qa.node.ts handling) **+ brand-new `tests/script-contract.test.ts`** (no contract tests exist today) | code + tests | Med — small API change, one consumer; must land before any warn-only check |
| 2 | C1(1,2), C3, C4, C6(1,3) | prompt text only | Low-Med — more constraints can raise minor_revision churn |
| 2.5 | B4, C5 | **node + prompt** (add pivotSentence/pivotBeatId/storyBeats to VD template vars, then rules) | Med — touches visual-director.node.ts; verify with resume from cached script stage |
| 3 | C2(1,2), PromptQA checks for C5/B4 | prompt + soft QA | Med — new QA checks need calibration on eval set |
| 4 | B1 (ledger), C1(3), contract echo check | schema + code + tests | High — new fields touch planner/writer/QA/contract; optional-schema + warn-severity per B1 mitigations; do behind artifact-cache resume tests |

**Rollout protocol** (uses existing infra):

1. Copy changed prompts to `v2.md` alongside `v1.md`. **Rev. 2 caveat:** `PromptPaths`
   hardcodes `v1.md` (`models/prompt-paths.ts`) — dropping in `v2.md` does *not* activate it.
   To A/B, either add an env-driven version selector in PromptPaths (preferred, revertible)
   or rename v2→v1 in-place on a branch. Plan the switch explicitly; don't assume drop-in.
2. Re-run 3-5 recent runs via `pnpm --filter youtube-shorts-orchestrator
   resume <ns>` with seeded script stages to isolate downstream nodes; compare
   `runs/<ns>/manifest.json` gate outcomes (ScriptQA status, PromptQA
   revisionTarget distribution) v1 vs v2. Note: cached planner artifacts validated by
   `scriptPlannerOutputSchema` are why B1/B3/C5 schema additions must be optional.
3. Track: major_revision rate per QA node, pivot/hook determinism failures,
   average scene count, total duration drift (word-budget checks should absorb
   bridge-sentence additions — verify targetWords sums still pass ±40%).
4. Promote v2 → v1 only when revision rates are flat-or-better and eval diffs
   show intended changes.

**Watch-outs:**

- Word budgets: bridge sentences and callback lines consume words; if ScriptQA
  check 10 starts failing, bump planner `targetWords` distribution guidance
  rather than dropping the rules.
- Deterministic-first philosophy: every new check that CAN be derived in code
  (loop pairing, boundary pairs, echo overlap) should be, leaving LLM QA to
  judge effectiveness only — consistent with the existing
  "derived in code / judged by QA" split in `script-contract.ts`.
- Keep trigger honesty: B2 devices must ride research facts; preserve the
  existing forbidden-phrasing list ("Nobody knows why…") verbatim in any new
  rule text.
