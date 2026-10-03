import { describe, it, expect } from "@jest/globals";
import { lenientEnum } from "../src/schemas/lenient-enum.js";
import { visualDirectorOutputSchema } from "../src/schemas/visual-director-output.js";
import { VisualPlanEntrySchema } from "../src/schemas/visual-planner-output.js";
import { SceneEntitySchema } from "../src/schemas/production.js";

describe("lenientEnum", () => {
  const Tones = ["low", "medium", "high"] as const;
  const tone = lenientEnum(Tones, {
    fallback: "medium",
    aliases: { mellow: "low", "mid-level": "medium", loud: "high" },
  });

  it("accepts canonical options", () => {
    expect(tone.parse("low")).toBe("low");
    expect(tone.parse("high")).toBe("high");
  });

  it("normalizes casing and separators", () => {
    expect(tone.parse("LOW")).toBe("low");
    expect(tone.parse("  High  ")).toBe("high");
    expect(tone.parse("mid-level")).toBe("medium");
    expect(tone.parse("mid_level")).toBe("medium");
  });

  it("resolves aliases", () => {
    expect(tone.parse("mellow")).toBe("low");
    expect(tone.parse("Loud")).toBe("high");
  });

  it("falls back instead of rejecting an unknown value", () => {
    expect(tone.parse("chartreuse")).toBe("medium");
    expect(tone.parse("")).toBe("medium");
  });

  it("still rejects non-string values", () => {
    expect(tone.safeParse(3).success).toBe(false);
    expect(tone.safeParse(null).success).toBe(false);
    expect(tone.safeParse({}).success).toBe(false);
  });

  it("keeps the output type to the exact literal union", () => {
    // Compile-time guarantee; the runtime assertion documents it.
    const parsed = tone.parse("loud") as (typeof Tones)[number];
    expect(Tones).toContain(parsed);
  });
});

describe("storyboard enum leniency", () => {
  it("coerces drifted renderStyle spellings", () => {
    const base = {
      sceneId: 1,
      colorMood: "cold blue",
      lighting: "soft",
      composition: "centered",
    };
    expect(
      VisualPlanEntrySchema.parse({ ...base, renderStyle: "3d" }).renderStyle,
    ).toBe("3D");
    expect(
      VisualPlanEntrySchema.parse({ ...base, renderStyle: "Photo Realistic" })
        .renderStyle,
    ).toBe("photorealistic");
    expect(
      VisualPlanEntrySchema.parse({ ...base, renderStyle: "archival" })
        .renderStyle,
    ).toBe("archive-style");
    expect(
      VisualPlanEntrySchema.parse({ ...base, renderStyle: "flat-art" })
        .renderStyle,
    ).toBe("illustration");
    // Unknown values degrade to the safe default rather than failing.
    expect(
      VisualPlanEntrySchema.parse({ ...base, renderStyle: "oil-painting" })
        .renderStyle,
    ).toBe("photorealistic");
  });

  it("coerces drifted scene entity types", () => {
    const base = { name: "Ada Lovelace" };
    expect(SceneEntitySchema.parse({ ...base, type: "Human" }).type).toBe(
      "person",
    );
    expect(SceneEntitySchema.parse({ ...base, type: "Location" }).type).toBe(
      "place",
    );
    expect(SceneEntitySchema.parse({ ...base, type: "corporation" }).type).toBe(
      "organization",
    );
    // Unknown values land on the enum's own catch-all, never on a guess.
    expect(SceneEntitySchema.parse({ ...base, type: "concept" }).type).toBe(
      "other",
    );
  });

  /**
   * Regression: the run that motivated this returned a storyboard whose only
   * defects were `emotionalBeat`, `entities[].type` and `renderStyle` spellings.
   * Every attempt was rejected wholesale, exhausting the minor-revision budget
   * with no usable scenes to fall back on.
   */
  it("accepts a storyboard whose only defects are enum spellings", () => {
    const schema = visualDirectorOutputSchema();
    const parsed = schema.safeParse({
      scenes: Array.from({ length: 4 }, (_, i) => ({
        sceneId: i + 1,
        narration: `Line ${i + 1}.`,
        sceneGoal: "Goal",
        visualDescription: "A view",
        sceneType: "landscape",
        cameraShot: "wide",
        cameraMotion: "static",
        transition: "cut",
        assetMode: "generated",
        sceneRole: "narrative",
        emotionalBeat: i === 0 ? "Intrigue" : "Mystery",
        entities: [{ name: "Ada", type: "Human" }],
        references: ["fact-001"],
      })),
      visualPlans: [
        {
          sceneId: 1,
          renderStyle: "Photoreal",
          colorMood: "cold",
          lighting: "soft",
          composition: "centered",
        },
        {
          sceneId: 2,
          renderStyle: "3d",
          colorMood: "cold",
          lighting: "soft",
          composition: "centered",
        },
        {
          sceneId: 3,
          renderStyle: "archival",
          colorMood: "cold",
          lighting: "soft",
          composition: "centered",
        },
        {
          sceneId: 4,
          renderStyle: "oil-painting",
          colorMood: "cold",
          lighting: "soft",
          composition: "centered",
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.scenes[0].emotionalBeat).toBe("mystery");
    expect(parsed.data.scenes[0].entities?.[0]?.type).toBe("person");
    expect(parsed.data.visualPlans.map((p) => p.renderStyle)).toEqual([
      "photorealistic",
      "3D",
      "archive-style",
      "photorealistic",
    ]);
  });
});
