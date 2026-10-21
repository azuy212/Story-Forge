import { describe, it, expect } from "@jest/globals";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROMPT_CHARS,
  composeImagePrompt,
  lintImagePrompt,
} from "../src/story/prompt.js";
import {
  REQUIRED_PROMPT_PLACEHOLDERS,
  loadStyleProfile,
} from "../src/story/style-profile.js";
import { styleProfilePath } from "../src/story/paths.js";
import { isPipelineError } from "../src/utils/errors.js";
import type { StoryStyleProfile } from "../src/story/style-profile.js";
import type { Character, SceneVisualSlots } from "../src/story/types.js";

const STYLE: StoryStyleProfile = {
  id: "test-style",
  description: "fixture",
  promptTemplate: [
    "A simple storybook illustration.",
    "Scene: {action}",
    "Characters:",
    "{characters}",
    "Setting: {setting}",
    "Key props: {props}",
    "Lighting: {lighting}",
    "Composition: {composition}",
    "No text, no lettering, no captions.",
  ].join("\n"),
  aspectInstruction: "Wide 16:9 landscape image at 1920 by 1080.",
  hardWords: [],
  explanationCues: [],
};

const COLUMBUS: Character = {
  id: "columbus",
  name: "Columbus",
  role: "the captain",
  visualDescription: "A tall man in a dark red coat.",
};

const CREW: Character = {
  id: "the_crew",
  name: "The crew",
  role: "the sailors",
  visualDescription: "Three tired sailors in rough linen shirts",
};

const CHARACTERS = [COLUMBUS, CREW];

const slots = (
  overrides: Partial<SceneVisualSlots> = {},
): SceneVisualSlots => ({
  sceneId: 1,
  action: "Columbus stands at the rail of the ship and points ahead.",
  characters: [
    {
      id: "columbus",
      pose: "standing at the rail with one arm raised",
      expression: "calm, eyebrows lifted",
    },
  ],
  setting: "the deck of a small wooden sailing ship on open water",
  props: ["a wooden rail", "coiled rope"],
  lighting: "warm low sunlight across the deck",
  composition: "wide framing with the captain on the left third",
  metaphor: false,
  ...overrides,
});

describe("story composeImagePrompt", () => {
  it("fills every placeholder from the registry and the style template", () => {
    const { prompt, characterIds } = composeImagePrompt({
      style: STYLE,
      slots: slots(),
      characters: CHARACTERS,
    });

    expect(characterIds).toEqual(["columbus"]);
    expect(prompt).toContain("A simple storybook illustration.");
    expect(prompt).toContain(
      "Scene: Columbus stands at the rail of the ship and points ahead.",
    );
    expect(prompt).toContain(
      "- Columbus: A tall man in a dark red coat. Pose: standing at the rail with one arm raised. Expression: calm, eyebrows lifted.",
    );
    expect(prompt).toContain("Key props: a wooden rail, coiled rope");
    // The aspect instruction is appended verbatim (DP4).
    expect(prompt.endsWith(STYLE.aspectInstruction)).toBe(true);
    // No leftover {placeholder} can reach the provider.
    for (const placeholder of REQUIRED_PROMPT_PLACEHOLDERS) {
      expect(prompt).not.toContain(`{${placeholder}}`);
    }
  });

  it("includes every slot character's registry text verbatim", () => {
    const { prompt } = composeImagePrompt({
      style: STYLE,
      slots: slots({
        characters: [
          {
            id: "columbus",
            pose: "standing at the rail",
            expression: "calm",
          },
          {
            id: "the_crew",
            pose: "hauling a rope",
            expression: "straining",
          },
        ],
      }),
      characters: CHARACTERS,
    });

    for (const slotCharacter of [{ id: "columbus" }, { id: "the_crew" }]) {
      const entry = CHARACTERS.find(
        (character) => character.id === slotCharacter.id,
      );
      expect(entry).toBeDefined();
      const description = entry!.visualDescription.trim().replace(/\.+$/, "");
      expect(prompt).toContain(description);
    }
  });

  it("never produces a doubled full stop when appending Pose/Expression", () => {
    const { prompt } = composeImagePrompt({
      style: STYLE,
      slots: slots(),
      characters: CHARACTERS,
    });
    expect(prompt).not.toContain("..");
  });

  it("falls back to a props sentence when no props are given", () => {
    const { prompt } = composeImagePrompt({
      style: STYLE,
      slots: slots({ props: [] }),
      characters: CHARACTERS,
    });
    expect(prompt).toContain("Key props: none beyond the setting");
  });

  it("injects character descriptions verbatim, never model-rewritten", () => {
    const { prompt } = composeImagePrompt({
      style: STYLE,
      slots: slots({
        characters: [
          { id: "the_crew", pose: "huddled at the rail", expression: "afraid" },
        ],
      }),
      characters: CHARACTERS,
    });
    expect(prompt).toContain("Three tired sailors in rough linen shirts");
  });

  it("throws for a slot that references an unregistered character", () => {
    let caught: unknown;
    try {
      composeImagePrompt({
        style: STYLE,
        slots: slots({
          characters: [{ id: "ghost", pose: "floating", expression: "blank" }],
        }),
        characters: CHARACTERS,
      });
    } catch (error) {
      caught = error;
    }
    expect(isPipelineError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("STORY_CHARACTER_UNKNOWN");
  });
});

describe("story lintImagePrompt", () => {
  const lint = (overrides: {
    prompt?: string;
    slots?: SceneVisualSlots;
    characters?: Character[];
    language?: string;
  }) =>
    lintImagePrompt({
      prompt: overrides.prompt ?? "A simple illustration.",
      slots: overrides.slots ?? slots(),
      characters: overrides.characters ?? CHARACTERS,
      language: overrides.language ?? "en",
    });

  const messages = (overrides: Parameters<typeof lint>[0]) =>
    lint(overrides)
      .map((issue) => issue.message)
      .join(" | ");

  it("accepts a clean composed prompt, including the style's own text ban", () => {
    const { prompt } = composeImagePrompt({
      style: STYLE,
      slots: slots(),
      characters: CHARACTERS,
    });
    expect(lint({ prompt })).toEqual([]);
  });

  it("rejects a slot that asks for readable text", () => {
    expect(
      messages({
        slots: slots({
          action: "He holds up a map labelled with the words of the treaty.",
        }),
      }),
    ).toContain("readable text");
  });

  // Regression from a real OpenRouter run: a printing-press story hard-failed
  // every scene because the lint matched the bare nouns "letters"/"words".
  // Printing equipment is the subject of the picture, not a legibility request.
  it.each([
    "Gutenberg leans over a wooden frame filled with tiny metal letters.",
    "A row of small metal letter blocks, reversed, sits on the bench.",
    "A large old printed Bible lies open on a wooden table.",
    "The page is covered in dried ink and carved type.",
  ])("accepts printing equipment that mentions letters: %s", (action) => {
    expect(messages({ slots: slots({ action }) })).toBe("");
  });

  it.each([
    "A sign that reads OPEN hangs above the door.",
    'He holds a letter that says "pay now".',
    "A poster spelling out the king's name.",
    "The title is clearly visible on the cover.",
  ])("rejects an explicit legibility request: %s", (action) => {
    expect(messages({ slots: slots({ action }) })).toContain("readable text");
  });

  // Second real-run regression: the model itself writes the refusal
  // ("…abstract shapes with no readable letters") and that was flagged as a
  // request for legible text.
  it.each([
    "A tray of metal letter blocks, shown as abstract shapes with no readable letters.",
    "A page of writing without any legible words.",
    "A sign with abstract marks instead of readable text.",
  ])("accepts an explicit refusal of legibility: %s", (action) => {
    expect(messages({ slots: slots({ action }) })).toBe("");
  });

  it("quotes the offending phrase rather than the start of the slot", () => {
    const report = messages({
      slots: slots({
        action:
          "A long description of a busy workshop that ends with a sign that reads OPEN.",
      }),
    });
    expect(report).toContain("sign that reads");
  });

  it.each([
    "a close-up of Columbus at the rail",
    "a tight portrait of the captain",
    "a headshot of the sailor, framed from the shoulders up",
    "a view of his face as he reads the chart",
  ])("rejects close framing in the composition: %s", (composition) => {
    expect(messages({ slots: slots({ composition }) })).toContain(
      "close, portrait and face shots",
    );
  });

  it("rejects close framing outside the composition slot too", () => {
    expect(
      messages({
        slots: slots({
          action: "A close-up of the sailor's face as the wind rises.",
        }),
      }),
    ).toContain("close, portrait and face shots");
  });

  it.each([
    "the crew waits in a line along the rail",
    "the sailors stand lined up on the deck",
    "a row of islanders watches from the beach",
  ])("rejects a group lineup: %s", (composition) => {
    expect(
      messages({
        slots: slots({
          characters: [
            {
              id: "the_crew",
              pose: "waiting together",
              expression: "uneasy",
            },
          ],
          composition,
        }),
        characters: [{ ...CREW, kind: "group" }, COLUMBUS],
      }),
    ).toContain("stagger the members in depth");
  });

  it("allows a lineup phrase when no group is in the scene", () => {
    expect(
      messages({
        slots: slots({
          composition:
            "a row of pebbles across the foreground, the captain on the left third",
        }),
      }),
    ).toBe("");
  });

  it("accepts face-to-face staging and the allowed shot vocabulary", () => {
    expect(
      messages({
        slots: slots({
          action:
            "Two sailors argue face to face while a third grips the rail.",
          composition:
            "a medium shot from the deck, the pair on the left third, the rail across the lower frame",
        }),
      }),
    ).toBe("");
  });

  it("rejects an adjacent repeated word", () => {
    expect(
      messages({ prompt: "Scene: The the ship drifts through calm water." }),
    ).toContain('repeats the adjacent word "The"');
  });

  it("rejects an unfilled placeholder", () => {
    expect(messages({ prompt: "Scene: {{action}} here." })).toContain(
      "unfilled placeholder",
    );
    expect(messages({ prompt: "Scene: [TODO] here." })).toContain(
      "unfilled placeholder",
    );
  });

  it("rejects empty required slots", () => {
    const issues = messages({
      slots: slots({ action: " ", setting: "", lighting: "", composition: "" }),
    });
    expect(issues).toContain("slot action is empty");
    expect(issues).toContain("slot setting is empty");
    expect(issues).toContain("slot lighting is empty");
    expect(issues).toContain("slot composition is empty");
  });

  it("rejects a slot character missing from the registry", () => {
    expect(
      messages({
        slots: slots({
          characters: [{ id: "ghost", pose: "floating", expression: "blank" }],
        }),
      }),
    ).toContain('slot references unregistered character "ghost"');
  });

  it("rejects characters outside the expected script for the language", () => {
    expect(
      messages({ prompt: "A ship named Аврора.", language: "en" }),
    ).toContain("outside the expected script");
    // The same script is expected (and allowed) when the job language is ru.
    expect(
      messages({ prompt: "Корабль Аврора.", language: "ru" }),
    ).not.toContain("outside the expected script");
  });

  it("rejects a prompt over the provider length limit", () => {
    expect(messages({ prompt: "a".repeat(MAX_PROMPT_CHARS + 1) })).toContain(
      `provider limit is ${MAX_PROMPT_CHARS}`,
    );
  });
});

describe("story loadStyleProfile", () => {
  let dir: string;

  const write = async (name: string, value: unknown): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  it("loads the shipped stickman profile with all six placeholders", async () => {
    const profile = await loadStyleProfile(
      styleProfilePath("stickman-history"),
    );
    expect(profile.id).toBe("stickman-history");
    for (const placeholder of REQUIRED_PROMPT_PLACEHOLDERS) {
      expect(profile.promptTemplate).toContain(`{${placeholder}}`);
    }
    expect(profile.aspectInstruction).toContain("16:9");
    expect(profile.hardWords.length).toBeGreaterThan(0);
    expect(profile.explanationCues.length).toBeGreaterThan(0);
  });

  it("reports a missing profile", async () => {
    await expect(
      loadStyleProfile("/nonexistent/style/profile.json"),
    ).rejects.toThrow(/not found or unreadable/);
  });

  it("rejects a template that is missing a placeholder", async () => {
    dir = await mkdtemp(join(tmpdir(), "story-style-"));
    try {
      const path = await write("broken.json", {
        id: "broken",
        promptTemplate: "Scene: {action} with {characters}",
        aspectInstruction: "Wide 16:9.",
      });
      let caught: unknown;
      try {
        await loadStyleProfile(path);
      } catch (error) {
        caught = error;
      }
      expect(isPipelineError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe("STORY_STYLE_INVALID");
      expect((caught as Error).message).toContain("{setting}");
      expect((caught as Error).message).toContain("{composition}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unparseable JSON as missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "story-style-"));
    try {
      const path = join(dir, "garbage.json");
      await writeFile(path, "{not json");
      let caught: unknown;
      try {
        await loadStyleProfile(path);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code: string }).code).toBe("STORY_STYLE_MISSING");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the shipped profile in sync with its declared placeholders", async () => {
    const raw = await readFile(styleProfilePath("stickman-history"), "utf-8");
    const parsed = JSON.parse(raw) as { promptTemplate: string };
    const used = [...parsed.promptTemplate.matchAll(/\{([a-z]+)\}/g)].map(
      (match) => match[1],
    );
    expect([...new Set(used)].sort()).toEqual(
      [...REQUIRED_PROMPT_PLACEHOLDERS].sort(),
    );
  });
});
