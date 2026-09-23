import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planQaRetryReset,
  resetLastStepQaRetries,
  describeQaRetryReset,
} from "../scripts/qa-retry-reset.mjs";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "qa-retry-reset-test-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

type Manifest = Record<string, any>;

function makeRun(
  ns: string,
  entries: Array<[string, string]> = [],
  extraManifest: Manifest = {},
): Manifest {
  const runDir = join(runsDir, ns);
  const manifest: Manifest = {
    llmUsage: {
      latest: "v1",
      versions: [{ version: 1, status: "complete" }],
    },
    ...extraManifest,
  };
  const refs: Manifest = {};
  for (const [type, status] of entries) {
    manifest[type] = {
      latest: "v1",
      versions: [{ version: 1, status }],
    };
    if (status !== "missing") {
      mkdirSync(join(runDir, "artifacts", type), { recursive: true });
      writeFileSync(
        join(runDir, "artifacts", type, "v1.json"),
        JSON.stringify({ type, status }),
      );
      refs[`${type}@v1`] = { type, version: 1 };
    }
  }
  mkdirSync(join(runDir, "state"), { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeFileSync(
    join(runDir, "state", "execution.json"),
    JSON.stringify(refs, null, 2),
  );
  return manifest;
}

function readManifest(ns: string): Manifest {
  return JSON.parse(readFileSync(join(runsDir, ns, "manifest.json"), "utf-8"));
}

function readRefs(ns: string): Manifest {
  return JSON.parse(
    readFileSync(join(runsDir, ns, "state", "execution.json"), "utf-8"),
  );
}

const UPSTREAM: Array<[string, string]> = [
  ["research", "complete"],
  ["researchQA", "complete"],
  ["scriptPlan", "complete"],
];

describe("planQaRetryReset", () => {
  it("pairs scriptQA frontier with its producer and clears nothing upstream", () => {
    const ns = "ns1";
    makeRun(ns, [
      ...UPSTREAM,
      ["script", "complete"],
      ["scriptQA", "complete"],
    ]);
    const result = planQaRetryReset(runsDir, ns);
    expect(result.reason).toBeNull();
    expect(result.frontier).toBe("scriptQA");
    expect(result.resetTypes).toEqual(["script", "scriptQA"]);
  });

  it("pairs promptQA frontier with visualDirector/thumbnailImage/prompts", () => {
    const ns = "ns2";
    makeRun(ns, [
      ...UPSTREAM,
      ["script", "complete"],
      ["scriptQA", "complete"],
      ["metadata", "complete"],
      ["thumbnail", "complete"],
      ["visualDirector", "complete"],
      ["thumbnailImage", "complete"],
      ["prompts", "complete"],
      ["promptQA", "complete"],
    ]);
    const result = planQaRetryReset(runsDir, ns);
    expect(result.reason).toBeNull();
    expect(result.frontier).toBe("promptQA");
    expect(result.resetTypes).toEqual([
      "visualDirector",
      "thumbnailImage",
      "prompts",
      "promptQA",
    ]);
  });

  it("resets a non-QC frontier alone", () => {
    const ns = "ns3";
    makeRun(ns, [
      ...UPSTREAM,
      ["script", "complete"],
      ["metadata", "complete"],
    ]);
    const result = planQaRetryReset(runsDir, ns);
    expect(result.frontier).toBe("metadata");
    expect(result.resetTypes).toEqual(["metadata"]);
  });

  it("includes residue after the frontier even when that stage is not complete", () => {
    const ns = "ns4";
    makeRun(ns, [
      ...UPSTREAM,
      ["script", "complete"],
      ["scriptQA", "complete"],
      ["metadata", "invalid"],
    ]);
    const result = planQaRetryReset(runsDir, ns);
    expect(result.frontier).toBe("scriptQA");
    expect(result.resetTypes).toEqual(["script", "scriptQA", "metadata"]);
  });

  it("no-ops when publish is complete", () => {
    const ns = "ns5";
    makeRun(ns, [...UPSTREAM, ["publish", "complete"]]);
    const result = planQaRetryReset(runsDir, ns);
    expect(result).toEqual({
      reason: "already-published",
      frontier: null,
      resetTypes: [],
    });
  });

  it("no-ops when no stage is complete", () => {
    const ns = "ns6";
    makeRun(ns, [["research", "invalid"]]);
    const result = planQaRetryReset(runsDir, ns);
    expect(result.reason).toBe("no-complete-stage");
  });

  it("no-ops when the run has no manifest", () => {
    expect(planQaRetryReset(runsDir, "missing-ns")).toEqual({
      reason: "no-manifest",
      frontier: null,
      resetTypes: [],
    });
  });
});

describe("resetLastStepQaRetries", () => {
  it("deletes artifact dirs, manifest entries, and execution refs for the reset types", () => {
    const ns = "ns-del";
    makeRun(ns, [
      ...UPSTREAM,
      ["script", "complete"],
      ["scriptQA", "complete"],
      ["metadata", "invalid"],
    ]);

    const result = resetLastStepQaRetries(runsDir, ns);
    expect(result.reason).toBeNull();
    expect(result.frontier).toBe("scriptQA");
    expect(result.deleted).toEqual({ script: 1, scriptQA: 1, metadata: 1 });

    for (const t of ["script", "scriptQA", "metadata"]) {
      expect(existsSync(join(runsDir, ns, "artifacts", t))).toBe(false);
    }
    // Upstream must survive so the resume replays it from cache.
    for (const t of ["research", "researchQA", "scriptPlan"]) {
      expect(existsSync(join(runsDir, ns, "artifacts", t))).toBe(true);
    }

    const manifest = readManifest(ns);
    expect("script" in manifest).toBe(false);
    expect("scriptQA" in manifest).toBe(false);
    expect("metadata" in manifest).toBe(false);
    expect(manifest.research).toBeDefined();
    expect(manifest.llmUsage).toBeDefined();

    const refs = readRefs(ns);
    expect("script@v1" in refs).toBe(false);
    expect("scriptQA@v1" in refs).toBe(false);
    expect(refs["research@v1"]).toBeDefined();
  });

  it("is a no-op in dry-run mode but still reports the plan", () => {
    const ns = "ns-dry";
    makeRun(ns, [
      ...UPSTREAM,
      ["script", "complete"],
      ["scriptQA", "complete"],
    ]);

    const result = resetLastStepQaRetries(runsDir, ns, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.frontier).toBe("scriptQA");
    expect(result.resetTypes).toEqual(["script", "scriptQA"]);
    expect(result.deleted).toEqual({});

    expect(existsSync(join(runsDir, ns, "artifacts", "script"))).toBe(true);
    expect(existsSync(join(runsDir, ns, "artifacts", "scriptQA"))).toBe(true);
    expect(readManifest(ns).script).toBeDefined();
  });

  it("returns the reason without touching the filesystem when it cannot reset", () => {
    const ns = "ns-pub";
    makeRun(ns, [...UPSTREAM, ["publish", "complete"]]);

    const result = resetLastStepQaRetries(runsDir, ns);
    expect(result.reason).toBe("already-published");
    expect(result.deleted).toEqual({});
    expect(readManifest(ns).publish).toBeDefined();
  });
});

describe("describeQaRetryReset", () => {
  it("reports the reason for a no-op", () => {
    expect(
      describeQaRetryReset({
        reason: "no-manifest",
        frontier: null,
        resetTypes: [],
      }),
    ).toBe("QA retry reset: nothing to reset (no-manifest)");
  });

  it("reports cleared types with per-type file counts", () => {
    expect(
      describeQaRetryReset({
        reason: null,
        frontier: "scriptQA",
        resetTypes: ["script", "scriptQA"],
        dryRun: false,
        deleted: { script: 3, scriptQA: 5 },
      }),
    ).toBe(
      'QA retry reset: cleared frontier "scriptQA" — script (3), scriptQA (5)',
    );
  });

  it("reports the plan in dry-run mode", () => {
    expect(
      describeQaRetryReset({
        reason: null,
        frontier: "scriptQA",
        resetTypes: ["script", "scriptQA"],
        dryRun: true,
        deleted: {},
      }),
    ).toBe(
      'QA retry reset: would clear frontier "scriptQA" — script, scriptQA',
    );
  });
});
