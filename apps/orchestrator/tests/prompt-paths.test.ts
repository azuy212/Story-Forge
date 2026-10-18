import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect, jest } from "@jest/globals";
import {
  promptPathsFor,
  resolveVisualDirectorPromptPath,
} from "../src/models/prompt-paths.js";
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

describe("PromptPaths.VisualDirector default", () => {
  afterEach(() => {
    if (previous === undefined) delete process.env.PROMPT_VERSION;
    else process.env.PROMPT_VERSION = previous;
  });

  it("loads the unit-based v2 prompt even while the global version stays v1", async () => {
    delete process.env.PROMPT_VERSION;
    jest.resetModules();
    const { PromptPaths: fresh } =
      await import("../src/models/prompt-paths.js");
    expect(fresh.VisualDirector).toBe("visual-director/v2.md");
    expect(fresh.ScriptWriter).toBe("script-writer/v1.md");
  });

  it("keeps the global override in charge for other agents", async () => {
    process.env.PROMPT_VERSION = "v2";
    jest.resetModules();
    const { PromptPaths: fresh } =
      await import("../src/models/prompt-paths.js");
    expect(fresh.VisualDirector).toBe("visual-director/v2.md");
    expect(fresh.ScriptWriter).toBe("script-writer/v2.md");
  });

  it("yields v2 and warns when a v1 pin names a removed prompt", async () => {
    process.env.PROMPT_VERSION = "v1";
    jest.resetModules();
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const { PromptPaths: fresh } =
      await import("../src/models/prompt-paths.js");
    // The v1 file is gone; the unit pipeline has no fallback below v2.
    expect(fresh.VisualDirector).toBe("visual-director/v2.md");
    expect(fresh.ScriptWriter).toBe("script-writer/v1.md");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("VisualDirector"),
      expect.objectContaining({ pinned: "v1", minimum: "v2" }),
    );
  });

  it("does not warn for a pin at or above the VisualDirector minimum", async () => {
    process.env.PROMPT_VERSION = "v2";
    jest.resetModules();
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const { PromptPaths: fresh } =
      await import("../src/models/prompt-paths.js");
    expect(fresh.VisualDirector).toBe("visual-director/v2.md");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when PROMPT_VERSION is unset", async () => {
    delete process.env.PROMPT_VERSION;
    jest.resetModules();
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const { PromptPaths: fresh } =
      await import("../src/models/prompt-paths.js");
    expect(fresh.VisualDirector).toBe("visual-director/v2.md");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to v2 and warns when a pinned prompt file is missing", async () => {
    // v9 pins visual-director/v9.md, which does not exist on disk (only v2
    // ships) — the pin must not point loadPrompt at a missing file.
    process.env.PROMPT_VERSION = "v9";
    jest.resetModules();
    const { logger } = await import("../src/utils/logger.js");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const { PromptPaths: fresh } =
      await import("../src/models/prompt-paths.js");
    expect(fresh.VisualDirector).toBe("visual-director/v2.md");
    // Other agents keep their pinned paths — the fallback is per-agent.
    expect(fresh.ScriptWriter).toBe("script-writer/v9.md");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no VisualDirector prompt file"),
      expect.objectContaining({
        pinned: "v9",
        missing: "visual-director/v9.md",
        using: "visual-director/v2.md",
      }),
    );
  });

  it("resolves a pinned prompt from the loader's own root regardless of cwd", async () => {
    // The existence lookup goes through loadPrompt's prompt root, captured
    // from the module location: from a cwd with no prompts/ directory at
    // all, the shipped v2 prompt is still found and no fallback fires.
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), "prompt-cwd-"));
    try {
      process.chdir(tempDir);
      process.env.PROMPT_VERSION = "v2";
      jest.resetModules();
      const { logger } = await import("../src/utils/logger.js");
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
      const { PromptPaths: fresh } =
        await import("../src/models/prompt-paths.js");
      expect(fresh.VisualDirector).toBe("visual-director/v2.md");
      expect(fresh.ScriptWriter).toBe("script-writer/v2.md");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads prompt content from a different cwd via the module-relative root", async () => {
    const { loadPrompt } = await import("../src/utils/load-prompt.js");
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), "prompt-cwd-"));
    try {
      process.chdir(tempDir);
      const prompt = await loadPrompt("visual-director/v2.md");
      // The loaded file is the shipped unit-based prompt, whatever cwd.
      expect(typeof prompt).toBe("string");
      expect(prompt).toContain("---");
      expect(prompt.length).toBeGreaterThan(100);
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws instead of warning when both the pinned prompt and the fallback are missing", () => {
    // Fail loudly: silently returning the missing v2 path would only crash
    // later at loadPrompt time with a cold stack trace.
    expect(() =>
      resolveVisualDirectorPromptPath({
        override: "v9",
        fileExists: () => false,
        warn: () => {},
      }),
    ).toThrow(
      "visual-director/v2.md is missing from prompts root — the narration-unit pipeline requires it. Reinstall the package so prompts/ ship.",
    );
  });
});
