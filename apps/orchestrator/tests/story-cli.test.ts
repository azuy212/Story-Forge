import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STORY_CLI_OVERRIDE_KEYS } from "../src/story/config.js";

/**
 * CLI contract tests.
 *
 * `scripts/story-video.mjs` is plain JS, so nothing type-checks the object it
 * hands to `resolveStoryConfig`. That is exactly how `--duration` ended up
 * writing `targetDurationSec` and doing nothing at all: every flag looked
 * wired up, and the pipeline silently used the env/default duration instead.
 * This test pins the script's mapping to the config contract.
 */

const SCRIPT = readFileSync(
  resolve(process.cwd(), "scripts/story-video.mjs"),
  "utf8",
);

/** Keys passed through `assign("<key>", …)`. */
function assignedKeys(): string[] {
  return [...SCRIPT.matchAll(/\bassign\("([\w]+)"/g)].map((match) => match[1]);
}

describe("story-video CLI", () => {
  it("maps every flag to a key the config actually reads", () => {
    // `topic` is the positional argument and `from` is a job option, not a
    // config override; every other flag must be assigned through `assign()`
    // under a name the config recognises.
    const jobOnlyKeys = ["from"];
    expect([...assignedKeys()].sort()).toEqual(
      [
        ...STORY_CLI_OVERRIDE_KEYS.filter((key) => key !== "topic"),
        ...jobOnlyKeys,
      ].sort(),
    );
    expect(SCRIPT).toContain("{ ...overrides, topic }");
  });

  it("passes the target duration under the name the config reads", () => {
    expect(assignedKeys()).toContain("duration");
    expect(assignedKeys()).not.toContain("targetDurationSec");
  });

  it("accepts --regenerate-prompts as a job option distinct from --from", () => {
    expect(SCRIPT).toContain('"--regenerate-prompts"');
    expect(SCRIPT).toContain(
      "overrides.regeneratePrompts = options.regeneratePrompts",
    );
    // It is a job option, not a config override, so the unknown-key guard
    // must exempt it explicitly.
    expect(SCRIPT).toContain('key !== "regeneratePrompts"');
  });

  it("accepts --regenerate-images as a job option and exempts it from the guard", () => {
    expect(SCRIPT).toContain('"--regenerate-images <sceneIds>"');
    expect(SCRIPT).toContain("overrides.regenerateImages = ids");
    expect(SCRIPT).toContain('key !== "regenerateImages"');
  });

  it("rejects an unknown override key instead of ignoring it", () => {
    // The guard has to exist, otherwise a future flag can go dead silently.
    expect(SCRIPT).toContain("unknownOverrides");
    expect(SCRIPT).toContain("STORY_CLI_OVERRIDE_KEYS");
  });

  it("loads the package env file before importing the pipeline", () => {
    // Nothing under src/ reads .env, so the CLI is the only place a real
    // OPENROUTER_API_KEY can enter the process.
    expect(SCRIPT).toContain('import "../src/runtime/network.mjs"');
    expect(SCRIPT).toContain("dotenv.config(");
    expect(SCRIPT).toContain('new URL("../.env", import.meta.url)');
    const envLoadAt = SCRIPT.indexOf("dotenv.config(");
    const pipelineImportAt = SCRIPT.indexOf("../dist/story/index.js");
    expect(envLoadAt).toBeGreaterThan(-1);
    expect(pipelineImportAt).toBeGreaterThan(envLoadAt);
  });
});
