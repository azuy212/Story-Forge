import { beforeAll, describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintStory } from "../src/story/lint.js";
import { composeImagePrompt, lintImagePrompt } from "../src/story/prompt.js";
import { countWords } from "../src/story/sentences.js";
import { loadStyleProfile } from "../src/story/style-profile.js";
import { styleProfilePath } from "../src/story/paths.js";
import type { StoryStyleProfile } from "../src/story/style-profile.js";
import type { Character, SceneVisualSlots } from "../src/story/types.js";

/**
 * Golden regression fixture: the 19-scene Columbus visual plan that produced
 * three real lint failures.
 *
 *  - scene 3 carried a stray CJK character in the composition slot;
 *  - scene 13 leaked the schema field name "StyleConstraints" into `action`;
 *  - the narration used "mutiny", "Genoese" and "uncharted" with no
 *    in-sentence explanation.
 *
 * The fixture runs through the REAL style profile and the real linters, so a
 * regression in either one turns this suite red immediately.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface GoldenScene {
  sceneId: number;
  narration: string;
  slots: SceneVisualSlots;
}

interface GoldenFixture {
  story: string;
  characters: Character[];
  scenes: GoldenScene[];
}

let fixture: GoldenFixture;
let style: StoryStyleProfile;

beforeAll(async () => {
  fixture = JSON.parse(
    await readFile(resolve(here, "fixtures/story-columbus-19.json"), "utf8"),
  ) as GoldenFixture;
  style = await loadStyleProfile(styleProfilePath("stickman-history"));
});

function lintScene(scene: GoldenScene) {
  const { prompt } = composeImagePrompt({
    style,
    slots: scene.slots,
    characters: fixture.characters,
  });
  return lintImagePrompt({
    prompt,
    slots: scene.slots,
    characters: fixture.characters,
    language: "en",
  });
}

describe("golden Columbus fixture", () => {
  it("still has the 19 scenes it was built from", () => {
    expect(fixture.scenes).toHaveLength(19);
    expect(fixture.scenes.map((scene) => scene.sceneId)).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 1),
    );
  });

  it("reading-level lint flags mutiny, Genoese and uncharted", () => {
    // Choose a budget that matches the fixture so the word-budget rule is not
    // what this test is measuring.
    const wpm = 150;
    const targetDurationSec = Math.round(
      (countWords(fixture.story) / wpm) * 60,
    );
    const report = lintStory(fixture.story, {
      wpm,
      targetDurationSec,
      hardWords: style.hardWords,
      explanationCues: style.explanationCues,
    });
    const all = report.issues.join("\n");
    for (const word of ["mutiny", "genoese", "uncharted"]) {
      expect(all).toMatch(new RegExp(`Hard word "${word}"`, "i"));
    }
  });

  it("prompt lint rejects the stray CJK character in scene 3", () => {
    const scene = fixture.scenes[2];
    const issues = lintScene(scene);
    expect(issues.map((issue) => issue.message).join("\n")).toMatch(
      /characters outside the expected script/,
    );
  });

  it("prompt lint rejects the StyleConstraints leak in scene 13", () => {
    const scene = fixture.scenes[12];
    const issues = lintScene(scene);
    expect(issues.map((issue) => issue.message).join("\n")).toMatch(
      /schema field name "StyleConstraints"/,
    );
  });

  it("every other scene passes the prompt lint unchanged", () => {
    for (const scene of fixture.scenes) {
      if (scene.sceneId === 3 || scene.sceneId === 13) continue;
      expect({
        sceneId: scene.sceneId,
        issues: lintScene(scene).map((issue) => issue.message),
      }).toEqual({ sceneId: scene.sceneId, issues: [] });
    }
  });
});
