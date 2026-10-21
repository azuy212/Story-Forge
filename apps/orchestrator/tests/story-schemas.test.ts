import { describe, it, expect } from "@jest/globals";
import {
  CharacterRegistrySchema,
  SceneGroupingSchema,
  SceneVisualSlotsSchema,
  StoryClaimSchema,
  StoryOutputSchema,
  StoryVerificationSchema,
} from "../src/story/types.js";

/**
 * Schema validation (brief test matrix #2).
 *
 * Every story agent answers with `json_object`, so the schema is the only thing
 * standing between a plausible-looking LLM answer and a scene with no
 * narration. These tests pin what is rejected, not just what is accepted.
 */

const slots = {
  sceneId: 1,
  action: "A stickman lifts a sheet of paper.",
  characters: [{ id: "gutenberg", pose: "standing", expression: "focused" }],
  setting: "A workshop.",
  props: ["a metal tray"],
  lighting: "Warm candlelight.",
  composition: "Wide shot.",
  metaphor: false,
};

describe("StoryOutputSchema", () => {
  it("accepts a story with a claim ledger", () => {
    const result = StoryOutputSchema.safeParse({
      title: "The Press",
      story: "A short story.",
      claims: [
        {
          claim: "Gutenberg used movable type.",
          status: "established",
          hedgeInNarration: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a story with no text or no title", () => {
    expect(
      StoryOutputSchema.safeParse({ title: "T", story: "", claims: [] })
        .success,
    ).toBe(false);
    expect(
      StoryOutputSchema.safeParse({ story: "A story.", claims: [] }).success,
    ).toBe(false);
  });

  it("requires the claims array, not an omitted field", () => {
    expect(
      StoryOutputSchema.safeParse({ title: "T", story: "A story." }).success,
    ).toBe(false);
  });

  it("rejects an unknown claim status", () => {
    expect(
      StoryClaimSchema.safeParse({
        claim: "Something.",
        status: "probably-true",
        hedgeInNarration: false,
      }).success,
    ).toBe(false);
  });

  it("requires hedgeInNarration to be an explicit boolean", () => {
    expect(
      StoryClaimSchema.safeParse({
        claim: "Something.",
        status: "disputed",
      }).success,
    ).toBe(false);
  });
});

describe("StoryVerificationSchema", () => {
  it("accepts an empty issue list", () => {
    expect(StoryVerificationSchema.safeParse({ issues: [] }).success).toBe(
      true,
    );
  });

  it("rejects an issue without a severity", () => {
    expect(
      StoryVerificationSchema.safeParse({
        issues: [
          {
            kind: "invented_motive",
            description: "The story invents a motive.",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown severity", () => {
    expect(
      StoryVerificationSchema.safeParse({
        issues: [
          {
            kind: "invented_motive",
            description: "…",
            severity: "catastrophic",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("SceneGroupingSchema", () => {
  it("accepts an ordered grouping", () => {
    expect(
      SceneGroupingSchema.safeParse({
        scenes: [
          { sceneId: 1, sentenceIds: ["s1", "s2"], visualPurpose: "Set up." },
          { sceneId: 2, sentenceIds: ["s3"], visualPurpose: "Turn." },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty sentence list or a missing purpose", () => {
    expect(
      SceneGroupingSchema.safeParse({
        scenes: [{ sceneId: 1, sentenceIds: [], visualPurpose: "Set up." }],
      }).success,
    ).toBe(false);
    expect(
      SceneGroupingSchema.safeParse({
        scenes: [{ sceneId: 1, sentenceIds: ["s1"] }],
      }).success,
    ).toBe(false);
  });

  it("rejects a non-integer or non-positive scene id", () => {
    expect(
      SceneGroupingSchema.safeParse({
        scenes: [{ sceneId: 0, sentenceIds: ["s1"], visualPurpose: "P" }],
      }).success,
    ).toBe(false);
    expect(
      SceneGroupingSchema.safeParse({
        scenes: [{ sceneId: 1.5, sentenceIds: ["s1"], visualPurpose: "P" }],
      }).success,
    ).toBe(false);
  });
});

describe("CharacterRegistrySchema", () => {
  it("accepts a registry entry", () => {
    expect(
      CharacterRegistrySchema.safeParse({
        registryVersion: 2,
        characters: [
          {
            id: "gutenberg",
            name: "Johannes Gutenberg",
            role: "printer",
            visualDescription: "A lean man in a dark robe.",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an entry without a visual description", () => {
    expect(
      CharacterRegistrySchema.safeParse({
        registryVersion: 2,
        characters: [{ id: "g", name: "G", role: "printer" }],
      }).success,
    ).toBe(false);
  });

  it("accepts an empty registry for a story with no recurring character", () => {
    expect(
      CharacterRegistrySchema.safeParse({
        registryVersion: 2,
        characters: [],
      }).success,
    ).toBe(true);
  });

  it("rejects a registry without the v2 version marker", () => {
    expect(CharacterRegistrySchema.safeParse({ characters: [] }).success).toBe(
      false,
    );
    expect(
      CharacterRegistrySchema.safeParse({
        registryVersion: 1,
        characters: [],
      }).success,
    ).toBe(false);
  });
});

describe("SceneVisualSlotsSchema", () => {
  it("accepts a complete slot set", () => {
    expect(SceneVisualSlotsSchema.safeParse(slots).success).toBe(true);
  });

  it("rejects more than four characters in one scene", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      id: `c${index}`,
      pose: "standing",
      expression: "calm",
    }));
    expect(
      SceneVisualSlotsSchema.safeParse({ ...slots, characters: many }).success,
    ).toBe(false);
  });

  it("rejects a blank required slot", () => {
    for (const field of ["action", "setting", "lighting", "composition"]) {
      expect(
        SceneVisualSlotsSchema.safeParse({ ...slots, [field]: "  " }).success,
      ).toBe(false);
    }
  });

  it("rejects a character without a pose", () => {
    expect(
      SceneVisualSlotsSchema.safeParse({
        ...slots,
        characters: [{ id: "gutenberg", expression: "focused" }],
      }).success,
    ).toBe(false);
  });

  it("defaults an omitted metaphor flag to false", () => {
    const { metaphor: _metaphor, ...withoutMetaphor } = slots;
    const parsed = SceneVisualSlotsSchema.safeParse(withoutMetaphor);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.metaphor).toBe(false);
  });

  it("trims the required slots instead of keeping the padding", () => {
    const parsed = SceneVisualSlotsSchema.safeParse({
      ...slots,
      action: "  A stickman lifts a sheet of paper.  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.action).toBe("A stickman lifts a sheet of paper.");
    }
  });
});
