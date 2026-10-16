import { describe, it, expect, afterEach } from "@jest/globals";
import { promptPathsFor } from "../src/models/prompt-paths.js";
import { config } from "../src/utils/config.js";

const previous = process.env.PROMPT_VERSION;

afterEach(() => {
  if (previous === undefined) delete process.env.PROMPT_VERSION;
  else process.env.PROMPT_VERSION = previous;
});

describe("promptPathsFor", () => {
  it("builds v1 paths for every agent", () => {
    const paths = promptPathsFor("v1");
    expect(paths.ScriptPlanner).toBe("script-planner/v1.md");
    expect(paths.VisualDirector).toBe("visual-director/v1.md");
    expect(Object.values(paths).every((p) => p.endsWith("/v1.md"))).toBe(true);
  });

  it("switches every agent when the version changes", () => {
    const paths = promptPathsFor("v2");
    expect(paths.ScriptQA).toBe("script-qa/v2.md");
    expect(Object.values(paths).every((p) => p.endsWith("/v2.md"))).toBe(true);
  });
});

describe("config.promptVersion", () => {
  it("defaults to v1 so dropping a v2 file in does not activate it", () => {
    delete process.env.PROMPT_VERSION;
    expect(config.promptVersion()).toBe("v1");
  });

  it("reads the version from the environment", () => {
    process.env.PROMPT_VERSION = "v2";
    expect(config.promptVersion()).toBe("v2");
  });

  it("falls back to v1 when set to an empty value", () => {
    process.env.PROMPT_VERSION = "";
    expect(config.promptVersion()).toBe("v1");
  });
});
