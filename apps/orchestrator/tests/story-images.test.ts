import { afterAll, describe, it, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetProvider } from "../src/providers/asset-provider.js";
import {
  ImageGenerationProviderError,
  normalizeImageGenerationError,
} from "../src/providers/image-generation-error.js";
import { resolveStoryConfig } from "../src/story/config.js";
import { runImageStage, validateSceneImage } from "../src/story/images.js";
import { jobPaths } from "../src/story/paths.js";
import type { StoryScene } from "../src/story/types.js";

/**
 * Image validation and image-to-scene mapping (brief test matrix #8).
 *
 * The DP4 gate is the only thing stopping a 1024x559 Gemini file (or a refusal
 * PNG) from reaching the renderer, so these fixtures are real images decoded by
 * the same ffprobe/ffmpeg path the pipeline uses — not mocks of it.
 */

const ROOT = mkdtempSync(join(tmpdir(), "story-images-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;

/** Render one still with lavfi into `dir`. */
function makeImage(dir: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  counter += 1;
  const path = join(dir, `fixture-${counter}.png`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      source,
      "-frames:v",
      "1",
      path,
    ],
    { stdio: "pipe" },
  );
  return path;
}

const STRUCTURED = (width: number, height: number) =>
  `color=c=0x224466:s=${width}x${height},drawbox=x=80:y=60:w=600:h=420:color=0xdd8844:t=fill`;

function gate(path: string, workDir: string) {
  return validateSceneImage(path, {
    minWidth: 1000,
    minHeight: 540,
    minAspect: 1.6,
    maxAspect: 1.9,
    workDir,
    tag: "test",
  });
}

describe("validateSceneImage", () => {
  const work = join(ROOT, "gate");
  mkdirSync(work, { recursive: true });

  it("accepts a 1920x1080 frame and reports its real dimensions", async () => {
    const path = makeImage(join(ROOT, "good"), STRUCTURED(1920, 1080));
    const result = await gate(path, work);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.width).toBe(1920);
      expect(result.result.height).toBe(1080);
      expect(result.result.aspect).toBeCloseTo(1.778, 2);
      expect(result.result.luminanceVariance).toBeGreaterThan(8);
    }
  });

  it("accepts the 1024x559 shape a real Gemini call returns", async () => {
    // DP4 was approved on these numbers: the provider ignores the size asked
    // for in the prompt, so the gate must admit its native output.
    const path = makeImage(join(ROOT, "gemini"), STRUCTURED(1024, 559));
    const result = await gate(path, work);
    expect(result.ok).toBe(true);
  });

  it("rejects a frame below the minimum resolution", async () => {
    const path = makeImage(join(ROOT, "small"), STRUCTURED(640, 360));
    const result = await gate(path, work);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("1000x540");
    }
  });

  it("rejects a square frame on aspect ratio alone", async () => {
    const path = makeImage(join(ROOT, "square"), STRUCTURED(1200, 1200));
    const result = await gate(path, work);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("aspect ratio");
    }
  });

  it("rejects a flat colour frame as blank", async () => {
    const path = makeImage(join(ROOT, "blank"), "color=c=0xffffff:s=1920x1080");
    const result = await gate(path, work);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("blank");
    }
  });

  it("rejects a file that is not an image", async () => {
    mkdirSync(join(ROOT, "corrupt"), { recursive: true });
    const path = join(ROOT, "corrupt", "not-an-image.png");
    writeFileSync(path, "this is not a png\n");
    const result = await gate(path, work);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/decode|video stream/);
    }
  });

  it("rejects a missing file", async () => {
    const result = await gate(join(ROOT, "nope", "missing.png"), work);
    expect(result.ok).toBe(false);
  });
});

describe("runImageStage", () => {
  const jobDir = join(ROOT, "job");
  const paths = jobPaths(jobDir);
  const config = resolveStoryConfig({ topic: "Images" });

  function scene(id: number, prompt = `Prompt for scene ${id}`): StoryScene {
    return {
      sceneId: id,
      sentenceIds: [`s${id}`],
      narration: `Narration ${id}.`,
      wordCount: 2,
      visualPurpose: "Purpose.",
      imagePrompt: prompt,
      imagePromptWarnings: [],
      status: {
        prompt: "done",
        image: "pending",
        audio: "pending",
        transcript: "pending",
        timing: "pending",
      },
      warnings: [],
    };
  }

  function providerFor(files: string[]): {
    provider: AssetProvider;
    calls: () => number;
  } {
    let calls = 0;
    const provider: AssetProvider = {
      async generateImage({ sceneId }) {
        calls += 1;
        return { url: files[(sceneId - 1) % files.length] };
      },
      async generateVideo() {
        throw new Error("not used");
      },
    };
    return { provider, calls: () => calls };
  }

  function setup(): void {
    mkdirSync(paths.imagesDir, { recursive: true });
    mkdirSync(paths.renderDir, { recursive: true });
  }

  it("maps each scene to its own file and records the real source size", async () => {
    setup();
    const a = makeImage(join(ROOT, "map"), STRUCTURED(1920, 1080));
    const b = makeImage(
      join(ROOT, "map"),
      `color=c=0x113322:s=1920x1080,drawbox=x=30:y=30:w=900:h=500:color=0xaa5533:t=fill`,
    );
    const { provider, calls } = providerFor([a, b]);
    const scenes = [scene(1), scene(2)];

    const result = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "test-run",
      workDir: paths.renderDir,
      providerLabel: "fake",
    });

    expect(result.failed).toEqual([]);
    expect(result.generated).toBe(2);
    expect(calls()).toBe(2);
    expect(scenes[0].image?.path).toBe(join(paths.imagesDir, "scene-001.png"));
    expect(scenes[1].image?.path).toBe(join(paths.imagesDir, "scene-002.png"));
    expect(scenes[0].image?.width).toBe(1920);
    expect(scenes[0].image?.provider).toBe("fake");
  });

  it("stops the batch on an exhausted quota and leaves the rest resumable", async () => {
    setup();
    let calls = 0;
    const provider: AssetProvider = {
      async generateImage({ sceneId, prompt }) {
        calls += 1;
        throw new ImageGenerationProviderError(
          normalizeImageGenerationError({
            provider: "fake",
            type: "quota_exhausted",
            message:
              "Gemini Create image is disabled; the account image quota looks exhausted",
            originalPrompt: prompt,
            sceneId,
          }),
        );
      },
      async generateVideo() {
        throw new Error("not used");
      },
    };
    const scenes = [scene(1), scene(2), scene(3), scene(4)];

    const result = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "test-run",
      workDir: paths.renderDir,
    });

    // Fail fast: the remaining scenes are never attempted, so an exhausted
    // quota cannot burn a generation timeout per scene.
    expect(calls).toBe(1);
    expect(result.quotaExhausted).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(scenes[0].status.image).toBe("failed");
    expect(
      scenes.slice(1).every((entry) => entry.status.image === "pending"),
    ).toBe(true);
    expect(scenes[0].warnings.join(" ")).toContain("quota");
  });

  it("fails the second scene when the provider returns identical bytes", async () => {
    setup();
    const same = makeImage(join(ROOT, "dup"), STRUCTURED(1920, 1080));
    const { provider } = providerFor([same]);
    const scenes = [scene(1), scene(2)];

    const result = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "test-run",
      workDir: paths.renderDir,
    });

    expect(result.failed.join(" ")).toContain("duplicate of scene 1");
    expect(scenes[1].status.image).toBe("failed");
  });

  it("reuses a finished image and regenerates only when the prompt changes", async () => {
    setup();
    const a = makeImage(join(ROOT, "reuse"), STRUCTURED(1920, 1080));
    const b = makeImage(
      join(ROOT, "reuse"),
      `color=c=0x221133:s=1920x1080,drawbox=x=30:y=30:w=700:h=500:color=0x33aa77:t=fill`,
    );
    const { provider, calls } = providerFor([a, b]);
    const scenes = [scene(1), scene(2)];

    const first = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "test-run",
      workDir: paths.renderDir,
    });
    expect(first.generated).toBe(2);
    expect(calls()).toBe(2);

    const second = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "test-run",
      workDir: paths.renderDir,
    });
    expect(second.generated).toBe(0);
    expect(second.reused).toBe(2);
    expect(calls()).toBe(2);

    // Editing the prompt invalidates only that scene (fingerprint resume).
    scenes[0].imagePrompt = "A different prompt for scene 1";
    const third = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "test-run",
      workDir: paths.renderDir,
    });
    expect(third.generated).toBe(1);
    expect(third.reused).toBe(1);
    expect(calls()).toBe(3);
  });

  it("forces a fresh generation and cache bypass for a requested scene", async () => {
    setup();
    const a = makeImage(join(ROOT, "force"), STRUCTURED(1920, 1080));
    const b = makeImage(
      join(ROOT, "force"),
      `color=c=0x331122:s=1920x1080,drawbox=x=40:y=40:w=800:h=500:color=0x44bb88:t=fill`,
    );
    const nonces: Array<string | undefined> = [];
    let calls = 0;
    const provider: AssetProvider = {
      async generateImage({ cacheNonce }) {
        nonces.push(cacheNonce);
        return { url: calls++ % 2 === 0 ? a : b };
      },
      async generateVideo() {
        throw new Error("not used");
      },
    };
    const scenes = [scene(1), scene(2)];

    await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "force-run",
      workDir: paths.renderDir,
    });
    expect(nonces).toEqual([undefined, undefined]);

    const regenerated = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "force-run",
      workDir: paths.renderDir,
      regenerateSceneIds: new Set([1]),
    });

    expect(regenerated.generated).toBe(1);
    expect(regenerated.reused).toBe(1);
    expect(nonces).toHaveLength(3);
    expect(nonces[2]).toEqual(expect.any(String));
  });

  it("retries a failed image gate with a fresh cache nonce", async () => {
    setup();
    const blank = makeImage(
      join(ROOT, "gate-retry"),
      "color=c=0xffffff:s=1920x1080",
    );
    const valid = makeImage(join(ROOT, "gate-retry"), STRUCTURED(1920, 1080));
    const nonces: Array<string | undefined> = [];
    let calls = 0;
    const provider: AssetProvider = {
      async generateImage({ cacheNonce }) {
        nonces.push(cacheNonce);
        return { url: calls++ === 0 ? blank : valid };
      },
      async generateVideo() {
        throw new Error("not used");
      },
    };
    const scenes = [scene(1)];

    const result = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "gate-retry",
      workDir: paths.renderDir,
    });

    expect(result.failed).toEqual([]);
    expect(result.generated).toBe(1);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeUndefined();
    expect(nonces[1]).toEqual(expect.any(String));
    expect(scenes[0].warnings.join(" ")).toContain("failed its gate");
  });

  it("retries a failed gate at most once and names the scene", async () => {
    setup();
    const blank = makeImage(
      join(ROOT, "gate-fail"),
      "color=c=0xffffff:s=1920x1080",
    );
    const nonces: Array<string | undefined> = [];
    let calls = 0;
    const provider: AssetProvider = {
      async generateImage({ cacheNonce }) {
        nonces.push(cacheNonce);
        calls += 1;
        return { url: blank };
      },
      async generateVideo() {
        throw new Error("not used");
      },
    };
    const scenes = [scene(7)];

    const result = await runImageStage({
      scenes,
      paths,
      config,
      assetProvider: provider,
      runId: "gate-fail",
      workDir: paths.renderDir,
    });

    // One initial call plus exactly one fresh-image retry; there is no third.
    expect(calls).toBe(2);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeUndefined();
    expect(nonces[1]).toEqual(expect.any(String));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatch(/^scene 7: /);
    expect(result.failed[0]).toContain("blank");
    expect(scenes[0].status.image).toBe("failed");
    expect(scenes[0].warnings.join(" ")).toContain(
      "retrying once with a fresh image",
    );
  });
});
