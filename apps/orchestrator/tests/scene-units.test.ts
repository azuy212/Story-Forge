import { describe, expect, it } from "@jest/globals";
import {
  buildNarrationUnits,
  finalizeSceneUnits,
  formatUnits,
  splitNarrationSentences,
} from "../src/utils/scene-units.js";
import type { NarrationUnit } from "../src/utils/scene-units.js";

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Small fixture narration whose unit layout is stable for any sane cap:
 * every sentence is at most 6 words, so it stays one unit per sentence.
 */
const SHORT =
  "The gate opened slowly. Nobody stepped through it. The torches went out.";

const shortUnits = buildNarrationUnits(SHORT, 12);

/** Builds finalize payloads straight from unit ids. */
function payload(
  ids: number[][],
  startId = 1,
  fields?: Array<Record<string, unknown> | undefined>,
) {
  return ids.map((unitIds, index) => ({
    sceneId: index + startId,
    unitIds,
    ...(fields?.[index] ?? {}),
  }));
}

describe("buildNarrationUnits", () => {
  it("turns each sentence into a unit and reproduces the narration exactly", () => {
    expect(shortUnits.map((u) => u.text)).toEqual([
      "The gate opened slowly.",
      "Nobody stepped through it.",
      "The torches went out.",
    ]);
    expect(shortUnits.map((u) => u.id)).toEqual([1, 2, 3]);
    expect(shortUnits.map((u) => u.wordCount)).toEqual([4, 4, 4]);
    expect(shortUnits.map((u) => u.text).join(" ")).toBe(normalize(SHORT));
  });

  it("splits an over-long sentence at the clause boundary nearest the middle", () => {
    // 9-word sentence with a comma after word 5; cap 4 forces a split.
    const narration =
      "The storm rolled over the ridge, and everyone ran inside.";
    const units = buildNarrationUnits(narration, 4);
    expect(units).toHaveLength(2);
    expect(units[0].text.endsWith(",")).toBe(true);
    expect(units[1].text.startsWith("and ")).toBe(true);
    expect(units.map((u) => u.text).join(" ")).toBe(narration);
    // The comma and the conjunction share one boundary position: the dry run
    // piece keeps its whole text even though it is over the cap (no safe
    // internal boundary), and the trailing piece fits.
    expect(units.map((u) => u.wordCount)).toEqual([6, 4]);
  });

  it("never splits inside a date, a proper name, or a number with its unit", () => {
    const narration =
      "In 1753, physicist Georg Richmann died instantly, 3 seconds after the flash.";
    // Aggressive cap: the comma after "1753," is unsalvageable (2 words on
    // the left, and it sits inside the leading date phrase), so the only cut
    // lands on the comma after "instantly,". The name, the date, and the
    // "3 seconds" unit each stay intact inside a single piece.
    const units = buildNarrationUnits(narration, 3);
    expect(units).toHaveLength(2);
    expect(units[0].text).toBe(
      "In 1753, physicist Georg Richmann died instantly,",
    );
    expect(units[1].text).toBe("3 seconds after the flash.");
  });

  it("never cuts directly after a leading date phrase", () => {
    // The comma after "1919," is a ≥4-word candidate (4 | 11), but a scene
    // must not open on "On January 3, 1919," then park the rest elsewhere —
    // the leading-date guard refuses it and the cut lands on the later comma.
    const narration =
      "On January 3, 1919, the entire sky darkened, and people far away heard the boom.";
    const units = buildNarrationUnits(narration, 8);
    expect(units.map((u) => u.text).join(" ")).toBe(normalize(narration));
    // The date keeps its day and year with the opener.
    expect(
      units.some((u) => u.text.startsWith("1919") || u.text.startsWith("the")),
    ).toBe(false);
    expect(units[0].text).toMatch(/On January 3, 1919,/);
  });

  it("keeps a sentence whole when no safe boundary exists", () => {
    // 8 words, no commas, no coordinating conjunctions.
    const hard = "Silence pressed against the windows of the old observatory.";
    const units = buildNarrationUnits(hard, 3);
    expect(units).toHaveLength(1);
    expect(units[0].wordCount).toBeGreaterThan(3);
    expect(units[0].text).toBe(hard);
  });

  it("formats units one per prompt line as `[id] text`", () => {
    expect(formatUnits(shortUnits.slice(0, 2))).toBe(
      "[1] The gate opened slowly.\n[2] Nobody stepped through it.",
    );
    expect(formatUnits([])).toBe("");
  });
});

describe("splitNarrationSentences", () => {
  it("treats sentence-final-prone forms as sentence ends", () => {
    expect(splitNarrationSentences("NASA. It reopened years later.")).toEqual([
      "NASA.",
      "It reopened years later.",
    ]);
    expect(splitNarrationSentences("It chased us. Then it vanished.")).toEqual([
      "It chased us.",
      "Then it vanished.",
    ]);
    expect(
      splitNarrationSentences("Case number 7. Then the files vanished."),
    ).toEqual(["Case number 7.", "Then the files vanished."]);
  });

  it("keeps common titles glued to their names", () => {
    expect(splitNarrationSentences("Dr. Smith lectured the class.")).toEqual([
      "Dr. Smith lectured the class.",
    ]);
    expect(
      splitNarrationSentences("Prof. Hale agreed. He left early."),
    ).toEqual(["Prof. Hale agreed.", "He left early."]);
  });

  it("does not end a sentence when lowercase text continues it", () => {
    // e.g. / i.e. followed by a lowercase continuation.
    expect(
      splitNarrationSentences(
        "It was loud, e.g. thunder rolling. Nobody moved.",
      ),
    ).toEqual(["It was loud, e.g. thunder rolling.", "Nobody moved."]);
    expect(
      splitNarrationSentences("The cause was clear, i.e. obvious."),
    ).toEqual(["The cause was clear, i.e. obvious."]);
  });

  it("keeps decimals intact", () => {
    expect(
      splitNarrationSentences("Pi is about 3.14. Everyone knows."),
    ).toEqual(["Pi is about 3.14.", "Everyone knows."]);
  });

  it("ends sentences after an internal-dot initialism", () => {
    // The masked-title list deliberately excludes country initials: "U.S."
    // ends the sentence when a new capitalized sentence follows.
    expect(
      splitNarrationSentences("It never left the U.S. Then it returned."),
    ).toEqual(["It never left the U.S.", "Then it returned."]);
  });

  it("keeps single-letter initials together", () => {
    expect(splitNarrationSentences("It was written by J. K. Rowling.")).toEqual(
      ["It was written by J. K. Rowling."],
    );
  });

  it("treats a ?! run as one terminal", () => {
    expect(splitNarrationSentences("Who counts it?! Nobody does.")).toEqual([
      "Who counts it?!",
      "Nobody does.",
    ]);
  });

  it("keeps closing quotes on their sentence and respects dialogue tags", () => {
    expect(
      splitNarrationSentences(
        'The report said the ball "floated calmly." She did not believe it.',
      ),
    ).toEqual([
      'The report said the ball "floated calmly."',
      "She did not believe it.",
    ]);
    // A lowercase dialogue tag after the closing quote continues the sentence.
    expect(
      splitNarrationSentences("“It was real.” she said, and left."),
    ).toEqual(["“It was real.” she said, and left."]);
    expect(
      splitNarrationSentences("“It was real.” She had seen one. It glowed."),
    ).toEqual(["“It was real.”", "She had seen one.", "It glowed."]);
  });

  it("keeps an ellipsis attached to a lowercase continuation", () => {
    expect(splitNarrationSentences("It hovered… then vanished.")).toEqual([
      "It hovered… then vanished.",
    ]);
    expect(splitNarrationSentences("It hovered... then vanished.")).toEqual([
      "It hovered... then vanished.",
    ]);
  });

  it("returns nothing for empty narration", () => {
    expect(splitNarrationSentences("   ")).toEqual([]);
  });
});

/** Narration fixture with unequal sentence lengths, for pair-selection tests. */
const UNEVEN =
  "The ancient stone towers loomed high above. Nothing moved below. Everyone waited.";

const unevenUnits = buildNarrationUnits(UNEVEN, 20);

describe("finalizeSceneUnits", () => {
  it("derives each scene's narration by joining its units", () => {
    const result = finalizeSceneUnits(payload([[1], [2, 3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: null,
    });
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1], [2, 3]]);
    expect(result.scenes.map((s) => s.narration)).toEqual([
      "The gate opened slowly.",
      "Nobody stepped through it. The torches went out.",
    ]);
    expect(result.unitCount).toBe(3);
    expect(result.repairRan).toBe(false);
  });

  it("assigns an orphan unit to the adjacent scene that stays under the cap", () => {
    // Scene 1 covers unit 1 only; unit 2 was never assigned.
    const result = finalizeSceneUnits(payload([[1], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: null,
    });
    expect(result.issues).toEqual([]);
    expect(result.repairRan).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("unit 2 was not assigned")),
    ).toBe(true);
    // Unit 2 lands in the first scene (both neighbours fit under the cap and
    // the previous scene is preferred).
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    // Coverage stays exact.
    expect(result.scenes.map((s) => s.narration).join(" ")).toBe(
      normalize(SHORT),
    );
  });

  it("splits a multi-unit scene over the word cap at a unit boundary", () => {
    const result = finalizeSceneUnits(payload([[1, 2, 3]]), shortUnits, {
      maxSceneWords: 9,
      minScenes: 1,
      maxScenes: null,
    });
    expect(result.issues).toEqual([]);
    expect(result.repairRan).toBe(true);
    // Split pieces share the parent's model-origin id (plan duplication is the
    // caller's job — this is the contract the node's mapping relies on).
    expect(result.scenes.map((s) => s.modelSceneIds)).toEqual([[1], [1]]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    expect(result.scenes.map((s) => s.narration).join(" ")).toBe(
      normalize(SHORT),
    );
  });

  it("keeps the first scene when scenes overlap", () => {
    const result = finalizeSceneUnits(
      payload([
        [1, 2],
        [2, 3],
      ]),
      shortUnits,
      {
        maxSceneWords: 12,
        minScenes: 1,
        maxScenes: null,
      },
    );
    expect(result.issues).toEqual([]);
    expect(result.repairRan).toBe(true);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    expect(
      result.warnings.some((w) => w.includes("claimed by multiple scenes")),
    ).toBe(true);
  });

  it("restores reading order after out-of-order scenes", () => {
    const result = finalizeSceneUnits(
      payload([[3], [1, 2]], 7), // model ids 7, 8 — out of order
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: null },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    expect(result.scenes.map((s) => s.modelSceneIds)).toEqual([[8], [7]]);
  });

  it("merges the smallest adjacent pair when the count exceeds the band", () => {
    const result = finalizeSceneUnits(payload([[1], [2], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: 2,
    });
    expect(result.issues).toEqual([]);
    expect(result.repairRan).toBe(true);
    expect(result.scenes).toHaveLength(2);
    // Smallest pair first: unit 1+2 (8 words) beats 2+3 (9 words).
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    expect(
      result.warnings.some((w) => w.includes("scene count exceeded")),
    ).toBe(true);
  });

  it("absorbs trailing units so the declared ending stays whole", () => {
    const ending = "The torches went out.";
    const result = finalizeSceneUnits(payload([[1, 2], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: null,
      endingNarration: ending,
    });
    // The final scene already ends with the ending — nothing to absorb.
    expect(result.issues).toEqual([]);
    expect(result.scenes).toHaveLength(2);

    const truncated = finalizeSceneUnits(payload([[1], [2], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: null,
      endingNarration: "Nobody stepped through it. The torches went out.",
    });
    expect(truncated.issues).toEqual([]);
    expect(truncated.scenes).toHaveLength(2);
    expect(truncated.scenes[1].unitIds).toEqual([2, 3]);
    expect(truncated.scenes[1].narration).toBe(
      "Nobody stepped through it. The torches went out.",
    );
    expect(truncated.warnings.some((w) => w.includes("absorbed"))).toBe(true);
  });

  it("reports unrepairable contracts so the caller retries the model", () => {
    // An invalid unit id is dropped, then the orphans are re-assigned and the
    // over-cap result is split apart — the repair fully recovers this one.
    const dropped = finalizeSceneUnits(payload([[1, 99]]), shortUnits, {
      maxSceneWords: 5,
      minScenes: 1,
      maxScenes: null,
    });
    expect(
      dropped.warnings.some((w) => w.includes("dropped invalid unit id")),
    ).toBe(true);
    expect(dropped.issues).toEqual([]);
    expect(dropped.scenes.map((s) => s.unitIds)).toEqual([[1], [2], [3]]);

    const empty = finalizeSceneUnits([], shortUnits, {
      maxSceneWords: 5,
      minScenes: 1,
      maxScenes: null,
    });
    expect(empty.issues).toContain("no scenes were produced");
    expect(empty.scenes).toEqual([]);

    const allInvalid = finalizeSceneUnits(payload([[99], [98]]), shortUnits, {
      maxSceneWords: 5,
      minScenes: 1,
      maxScenes: null,
    });
    expect(allInvalid.issues).toContain("every scene had invalid unit ids");
  });

  it("carries modelSceneIds through merges, splits, and absorbs", () => {
    // Merge (count band) concatenates both scenes' model ids.
    const merged = finalizeSceneUnits(
      [
        { sceneId: 10, unitIds: [1] },
        { sceneId: 11, unitIds: [2] },
        { sceneId: 12, unitIds: [3] },
      ],
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: 2 },
    );
    expect(merged.scenes.map((s) => s.modelSceneIds)).toEqual([[10, 11], [12]]);

    // Winner-first: when the protected scene is the pair's later member, its
    // id leads (the visual-plan mapping reads the first origin id). The
    // winning scene here is only position-protected (last), not marker-
    // protected, so the pair stays mergeable.
    const winnerLater = finalizeSceneUnits(
      payload([[1], [2], [3]], 10, [undefined, { sceneGoal: "Build tension" }]),
      unevenUnits,
      { maxSceneWords: 8, minScenes: 1, maxScenes: 2 },
    );
    expect(winnerLater.scenes.map((s) => s.modelSceneIds)).toEqual([
      [10],
      [12, 11],
    ]);
  });

  it("fills a scene's gap whose missing units are orphans", () => {
    // Scene 1 covers [1, 3] — unit 2 was skipped and is claimed by nobody.
    const result = finalizeSceneUnits(payload([[1, 3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: null,
    });
    expect(result.issues).toEqual([]);
    expect(result.repairRan).toBe(true);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2, 3]]);
    expect(result.warnings.some((w) => w.includes("skipped units 2"))).toBe(
      true,
    );
    expect(result.scenes.map((s) => s.narration).join(" ")).toBe(
      normalize(SHORT),
    );
  });

  it("does not fill a gap whose missing unit another scene claims", () => {
    // Unit 2 belongs to scene 2, so scene 1's gap must NOT be filled — the
    // payload is irreparable (coverage cannot become exactly-once-in-order)
    // and the caller retries the model.
    const result = finalizeSceneUnits(
      [
        { sceneId: 10, unitIds: [1, 3] },
        { sceneId: 11, unitIds: [2] },
      ],
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: null },
    );
    expect(result.issues).not.toEqual([]);
    // No fabricated unit-2 insertion ever happened.
    expect(result.warnings.some((w) => w.includes("skipped units 2"))).toBe(
      false,
    );
  });

  it("unions list fields (sourceBeatIds, references, entities) when scenes merge", () => {
    const entityA = { name: "gate" };
    const entityB = { name: "torch" };
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 1, [
        {
          sourceBeatIds: [1, 2],
          references: ["moon-age-1", "stone"],
          entities: [entityA],
        },
        {
          sourceBeatIds: [2, 3],
          references: ["stone", "river"],
          entities: [entityB],
        },
        { sourceBeatIds: [4], references: [], entities: [] },
      ]),
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: 2 },
    );
    // Scene 1+2 merge into the first (smallest word count), keeping the first
    // scene's scalar fields and unioning the list fields in reading order,
    // deduplicated.
    expect(result.scenes).toHaveLength(2);
    const merged = result.scenes[0];
    expect(merged.sourceBeatIds).toEqual([1, 2, 3]);
    expect(merged.references).toEqual(["moon-age-1", "stone", "river"]);
    expect(merged.entities).toEqual([entityA, entityB]);
    // The survivor's own scalar fields win.
    expect(result.scenes[1].sourceBeatIds).toEqual([4]);
  });

  it("keeps the first scene's fields on the wholesale overlap fold", () => {
    // Scene 2's only unit is claimed by scene 1, so scene 2 folds into scene 1
    // wholesale: scene 1 keeps its own fields and unions the absorbed one's.
    const result = finalizeSceneUnits(
      payload([[1, 2], [2]], 1, [
        { sourceBeatIds: [1], cameraShot: "wide", sceneGoal: "Set the gate" },
        { sourceBeatIds: [2], cameraShot: "aerial" },
      ]),
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: null },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].cameraShot).toBe("wide");
    expect(result.scenes[0].sceneGoal).toBe("Set the gate");
    expect(result.scenes[0].sourceBeatIds).toEqual([1, 2]);
  });

  it("marks split-off pieces as continuations with a different camera treatment", () => {
    const result = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [
        {
          sceneGoal: "Establish the abandoned gate",
          cameraShot: "wide",
          cameraMotion: "slow-pan",
          emphasis: "high",
          transition: "fade",
          visualAnchor: "gate",
        },
      ]),
      shortUnits,
      { maxSceneWords: 9, minScenes: 1, maxScenes: null },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    // The first piece keeps the scene's identity untouched.
    expect(result.scenes[0].emphasis).toBe("high");
    expect(result.scenes[0].cameraShot).toBe("wide");
    expect(result.scenes[0].transition).toBe("fade");
    expect(result.scenes[0].sceneGoal).toBe("Establish the abandoned gate");
    // The split-off piece reads as a continuation of the same subject: a
    // wide parent steps down to medium, the motion is untouched.
    const piece = result.scenes[1];
    expect(piece.transition).toBe("cut");
    expect(piece.emphasis).toBe("medium");
    expect(piece.cameraShot).toBe("medium");
    expect(piece.cameraMotion).toBe("slow-pan");
    expect(piece.visualAnchor).toBe("gate");
    expect(piece.sceneGoal).toBe("Continues: Establish the abandoned gate");
  });

  it("keeps an aerial parent's shot on split pieces and rotates the camera motion", () => {
    const result = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [
        {
          cameraShot: "aerial",
          cameraMotion: "static",
        },
      ]),
      shortUnits,
      { maxSceneWords: 9, minScenes: 1, maxScenes: null },
    );
    expect(result.scenes).toHaveLength(2);
    // The aerial angle is the subject; the motion carries the change.
    expect(result.scenes[0].cameraShot).toBe("aerial");
    expect(result.scenes[0].cameraMotion).toBe("static");
    expect(result.scenes[1].cameraShot).toBe("aerial");
    expect(result.scenes[1].cameraMotion).toBe("push-in");

    // A moving aerial parent keeps its shot too, on the motion ladder.
    const moving = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [
        { cameraShot: "aerial", cameraMotion: "push-in" },
      ]),
      shortUnits,
      { maxSceneWords: 9, minScenes: 1, maxScenes: null },
    );
    expect(moving.scenes[1].cameraShot).toBe("aerial");
    expect(moving.scenes[1].cameraMotion).toBe("pull-back");
  });

  it("steps a wide parent down to medium and a close-up parent back to medium", () => {
    const wide = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [{ cameraShot: "wide", cameraMotion: "orbit" }]),
      shortUnits,
      { maxSceneWords: 9, minScenes: 1, maxScenes: null },
    );
    expect(wide.scenes[1].cameraShot).toBe("medium");
    // The shot-swap branch does not touch the motion.
    expect(wide.scenes[1].cameraMotion).toBe("orbit");

    const closeUp = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [{ cameraShot: "close-up" }]),
      shortUnits,
      { maxSceneWords: 9, minScenes: 1, maxScenes: null },
    );
    expect(closeUp.scenes[1].cameraShot).toBe("medium");
  });

  it("keeps structural scene goals unprefixed and high emphasis unsplit twice", () => {
    // A pivot scene keeps its marker goal on both pieces, and the pivot is
    // exactly the one scene that stays `high`.
    const result = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [
        {
          sceneGoal: "Pivot: the reveal",
          cameraShot: "wide",
          emphasis: "high",
        },
      ]),
      shortUnits,
      { maxSceneWords: 9, minScenes: 1, maxScenes: null },
    );
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0].sceneGoal).toBe("Pivot: the reveal");
    expect(result.scenes[1].sceneGoal).toBe("Pivot: the reveal");
    const high = result.scenes.filter((s) => s.emphasis === "high");
    expect(high).toHaveLength(1);
    expect(high[0].unitIds).toEqual([1, 2]);
  });

  it("refuses the band merge when every pair holds a marker and reports the count", () => {
    // A mid-list pivot is tier-3 protected, so pairing it with scene 1 is
    // marker-blocked, and so is the pair with scene 3. The band merge is
    // fail-closed: nothing merges and the issue names the unmergeable count
    // for the caller's retry feedback.
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 1, [
        { emphasis: "low", sceneGoal: "Set the stage", cameraShot: "wide" },
        {
          emphasis: "high",
          sceneGoal: "Pivot: the reveal",
          visualAnchor: "pivot-subject",
        },
        { emphasis: "low", sceneGoal: "Hold the tension", cameraShot: "wide" },
      ]),
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: 2 },
    );
    expect(result.issues).toContain(
      "scene count 3 is above the maximum of 2 and no unprotected scenes can be merged",
    );
    // Nothing merged: the pivot stays intact for the model to re-group.
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[1].emphasis).toBe("high");
    expect(result.scenes[1].sceneGoal).toBe("Pivot: the reveal");
  });

  it("gives the overlap fold to a marker-protected scene over a position-only edge", () => {
    // Scene 2's only unit is claimed by scene 1, so scene 2 folds into
    // scene 1 — but the pivot's tier 3 outranks the opening scene's
    // position-only tier 2: a pivot or bookend is never dropped by overlap.
    const result = finalizeSceneUnits(
      payload([[1, 2], [2]], 1, [
        { sceneGoal: "Set the gate", cameraShot: "wide" },
        {
          emphasis: "high",
          sceneGoal: "Pivot: the reveal",
          visualAnchor: "pivot-subject",
        },
      ]),
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: null },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].emphasis).toBe("high");
    expect(result.scenes[0].sceneGoal).toBe("Pivot: the reveal");
    expect(result.scenes[0].visualAnchor).toBe("pivot-subject");
    // The winner's own field set carries over wholesale.
    expect(result.scenes[0].cameraShot).toBeUndefined();
    // And the winner's model id leads (the plan mapping reads it first).
    expect(result.scenes[0].modelSceneIds).toEqual([2, 1]);
  });

  it("folds a duplicate-claiming middle scene into its legitimate owner", () => {
    // Scene 2's only unit was claimed by scene 1, so it folds into scene 1
    // right away: mid-list, no markers — nothing protects the duplicate and
    // the owner keeps its identity.
    const result = finalizeSceneUnits(
      payload([[1, 2], [2], [3]], 1, [
        { sceneGoal: "Set the gate", cameraShot: "wide" },
        { sceneGoal: "Usurp the gate", cameraShot: "aerial" },
        { sceneGoal: "Hold the tension", cameraShot: "wide" },
      ]),
      shortUnits,
      { maxSceneWords: 12, minScenes: 1, maxScenes: null },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
    expect(result.scenes[0].sceneGoal).toBe("Set the gate");
    expect(result.scenes[0].cameraShot).toBe("wide");
    expect(result.scenes[0].modelSceneIds).toEqual([1, 2]);
  });

  it("protects a marker-free pivot scene through a band merge and an overlap fold", () => {
    // Content-based protection: the pivot sentence spans unit 1, so the scene
    // covering it scores 3 with no model markers — the band merge spares it
    // (the only allowed pair is the one away from the pivot).
    const banded = finalizeSceneUnits(payload([[1], [2], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: 2,
      pivotSentence: "the   GATE opened slowly", // case/whitespace drift only
    });
    expect(banded.issues).toEqual([]);
    expect(banded.scenes.map((s) => s.unitIds)).toEqual([[1], [2, 3]]);
    expect(banded.scenes[0].narration).toBe("The gate opened slowly.");

    // Overlap fold: the duplicate scene folds INTO the pivot scene, and the
    // pivot's tier 3 outranks the duplicate's position-only tier 2 — the
    // merged scene keeps the pivot's identity wholesale.
    const folded = finalizeSceneUnits(
      payload([[1, 2], [2]], 1, [
        { visualAnchor: "pivot-anchor", cameraShot: "wide" },
        { visualAnchor: "usurping-anchor", cameraShot: "aerial" },
      ]),
      shortUnits,
      {
        maxSceneWords: 12,
        minScenes: 1,
        maxScenes: null,
        pivotSentence: "The gate opened slowly.",
      },
    );
    expect(folded.issues).toEqual([]);
    expect(folded.scenes).toHaveLength(1);
    expect(folded.scenes[0].visualAnchor).toBe("pivot-anchor");
    expect(folded.scenes[0].cameraShot).toBe("wide");
    expect(folded.scenes[0].modelSceneIds).toEqual([1, 2]);
  });

  it("blocks a merge for an unmarked scene holding the pivot sentence exactly like a Pivot: maker", () => {
    // The pivot sentence spans unit 2 — scene 2 is tier 3 without any marker.
    // Pairing it with scene 1 is blocked, just as for a Pivot: scene from the
    // earlier marker test: the run stays fail-closed with the same issue.
    const result = finalizeSceneUnits(payload([[1], [2], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: 2,
      pivotSentence: "Nobody stepped through it.",
    });
    expect(result.issues).toContain(
      "scene count 3 is above the maximum of 2 and no unprotected scenes can be merged",
    );
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[1].narration).toBe("Nobody stepped through it.");
  });

  it("warns and skips content protection when the pivot sentence is not in the narration", () => {
    // An unknown pivot sentence cannot protect anything: protection stays
    // marker/position-based and the run behaves exactly as without one.
    const result = finalizeSceneUnits(payload([[1], [2], [3]]), shortUnits, {
      maxSceneWords: 12,
      minScenes: 1,
      maxScenes: 2,
      pivotSentence: "An entirely fictional pivot sentence.",
    });
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1, 2], [3]]);
  });

  it("refuses to absorb a protected previous scene and names both scenes and the ending", () => {
    // The declared ending spans units 2 and 3; scene 2 is a pivot (tier 3),
    // so absorbing it into the final scene would erase a protected scene —
    // the run reports the issue with the ending and both scene ids instead.
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 12, [
        undefined,
        { sceneGoal: "Pivot: nothing moves" },
        { visualAnchor: "gate" },
      ]),
      shortUnits,
      {
        maxSceneWords: 12,
        minScenes: 1,
        maxScenes: null,
        endingNarration: "Nobody stepped through it. The torches went out.",
      },
    );
    expect(result.issues).toHaveLength(1);
    // The issue names the ending verbatim, both scene ids, and the refusal.
    expect(result.issues[0]).toContain(
      'declared ending "Nobody stepped through it. The torches went out." crosses scene 13 and scene 14',
    );
    expect(result.issues[0]).toContain(
      "scene 13 is protected and cannot be absorbed",
    );
    // Nothing was absorbed: the payload is left for the model to regroup.
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1], [2], [3]]);
  });

  it("skips the absorb with a warning instead of vetoing on a recovered run", () => {
    // Salvage path (`recovering: true`): a recovered payload exists to finish
    // a run that would otherwise die, so the protected scene still blocks the
    // absorb — but the failure degrades to a warning for the node's
    // ending-contract downgrade instead of hard-failing the storyboard.
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 12, [
        undefined,
        { sceneGoal: "Pivot: nothing moves" },
        { visualAnchor: "gate" },
      ]),
      shortUnits,
      {
        maxSceneWords: 12,
        minScenes: 1,
        maxScenes: null,
        endingNarration: "Nobody stepped through it. The torches went out.",
        recovering: true,
      },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1], [2], [3]]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'declared ending "Nobody stepped through it. The torches went out." not absorbed into the final scene',
      ),
    ]);
    expect(result.warnings[0]).toContain("scene 13 is protected");
  });

  it("bookends the content when it absorbs a neighbour for the declared ending", () => {
    // Unit lengths are 7 | 3 | 2 words with an 8-word cap, so pair (1,2) does
    // not fit, and pair (2,3) holds the Bookend marker — tier 3 is never put
    // into a band-merge pair. The Bookend identity still survives when the
    // declared ending forces the absorb fold: there the final scene always
    // wins, and the merged scene keeps its whole field set.
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 1, [
        { sceneGoal: "Set the stage", cameraShot: "wide" },
        { sceneGoal: "Build tension", visualAnchor: "stairwell" },
        {
          sceneGoal: "Bookend: back at the gate",
          visualAnchor: "gate",
          cameraShot: "wide",
          emphasis: "low",
        },
      ]),
      unevenUnits,
      {
        maxSceneWords: 8,
        minScenes: 1,
        maxScenes: null,
        endingNarration: "Nothing moved below. Everyone waited.",
      },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1], [2, 3]]);
    expect(result.scenes[1].sceneGoal).toBe("Bookend: back at the gate");
    expect(result.scenes[1].visualAnchor).toBe("gate");
    expect(result.scenes[1].narration).toBe(
      "Nothing moved below. Everyone waited.",
    );
  });

  it("keeps an unmarked final scene's identity in the smallest fitting pair", () => {
    // Pair (1,2) does not fit and (2,3) is the only merge candidate. The
    // final scene carries no markers but sits at the work list's last
    // position, so it scores 2 by position and wins — its anchor and
    // emotional beat survive untouched.
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 1, [
        { sceneGoal: "Set the stage", cameraShot: "wide" },
        { sceneGoal: "Build tension", visualAnchor: "stairwell" },
        { visualAnchor: "gate", emotionalBeat: "relief" },
      ]),
      unevenUnits,
      { maxSceneWords: 8, minScenes: 1, maxScenes: 2 },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1], [2, 3]]);
    expect(result.scenes[1].visualAnchor).toBe("gate");
    expect(result.scenes[1].emotionalBeat).toBe("relief");
  });

  it("keeps the final scene's identity when it absorbs a neighbour for the declared ending", () => {
    // The declared ending spans the last two units; the final scene absorbs
    // the previous scene wholesale. The final scene always wins the absorb
    // fold — its own beat and anchor survive, never the absorbed scene's.
    const result = finalizeSceneUnits(
      payload([[1], [2], [3]], 1, [
        { sceneGoal: "Set the stage" },
        { emotionalBeat: "tension", visualAnchor: "stairwell" },
        { emotionalBeat: "reflection", visualAnchor: "gate" },
      ]),
      shortUnits,
      {
        maxSceneWords: 12,
        minScenes: 1,
        maxScenes: null,
        endingNarration: "Nobody stepped through it. The torches went out.",
      },
    );
    expect(result.issues).toEqual([]);
    expect(result.scenes.map((s) => s.unitIds)).toEqual([[1], [2, 3]]);
    expect(result.scenes[1].emotionalBeat).toBe("reflection");
    expect(result.scenes[1].visualAnchor).toBe("gate");
    expect(result.scenes[1].narration).toBe(
      "Nobody stepped through it. The torches went out.",
    );
    expect(result.warnings.some((w) => w.includes("absorbed scene"))).toBe(
      true,
    );
  });

  it("chains each split piece's camera off the previous piece", () => {
    const wide = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [{ cameraShot: "wide", cameraMotion: "orbit" }]),
      shortUnits,
      { maxSceneWords: 4, minScenes: 1, maxScenes: null },
    );
    expect(wide.issues).toEqual([]);
    expect(wide.scenes).toHaveLength(3);
    // Piece 2 derives from the parent, piece 3 from piece 2 — wide → medium
    // → close-up, so no two consecutive pieces share the shot.
    expect(wide.scenes.map((s) => s.cameraShot)).toEqual([
      "wide",
      "medium",
      "close-up",
    ]);
    // The shot-swap branch does not touch the motion at any link.
    expect(wide.scenes.map((s) => s.cameraMotion)).toEqual([
      "orbit",
      "orbit",
      "orbit",
    ]);

    // The keep-shot branch rotates the motion chain-wide.
    const aerial = finalizeSceneUnits(
      payload([[1, 2, 3]], 1, [
        { cameraShot: "aerial", cameraMotion: "static" },
      ]),
      shortUnits,
      { maxSceneWords: 4, minScenes: 1, maxScenes: null },
    );
    expect(aerial.issues).toEqual([]);
    expect(aerial.scenes).toHaveLength(3);
    expect(aerial.scenes.map((s) => s.cameraShot)).toEqual([
      "aerial",
      "aerial",
      "aerial",
    ]);
    expect(aerial.scenes.map((s) => s.cameraMotion)).toEqual([
      "static",
      "push-in",
      "pull-back",
    ]);
  });
});
