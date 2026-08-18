import { mkdir, writeFile, readFile, rename, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ArtifactReference,
  ArtifactRecord,
  ArtifactType,
  ArtifactMeta,
  Manifest,
  ManifestEntry,
} from "../types.js";
import type { ArtifactStore } from "../store.js";
import { getRunsDir, resolveRunNamespace } from "../namespace.js";

function runDir(runId: string): string {
  return join(getRunsDir(), runId);
}

function artifactsDir(runId: string): string {
  return join(runDir(runId), "artifacts");
}

function typeDir(runId: string, type: ArtifactType): string {
  return join(artifactsDir(runId), type);
}

function manifestPath(runId: string): string {
  return join(runDir(runId), "manifest.json");
}

function artifactPath(
  runId: string,
  type: ArtifactType,
  version: number,
): string {
  return join(typeDir(runId, type), `v${version}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Per-runId promise-chain lock. Parallel nodes (fan-out) do
 * read-modify-write on the manifest; serializing per run prevents lost
 * updates and duplicate version allocation. Cross-process safety is out of
 * scope — a run is owned by one process.
 */
const locks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  locks.set(key, chained);
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === chained) locks.delete(key);
    }
  });
}

async function readManifest(runId: string): Promise<Manifest> {
  try {
    const content = await readFile(manifestPath(runId), "utf-8");
    return JSON.parse(content) as Manifest;
  } catch {
    return {} as Manifest;
  }
}

async function writeManifest(runId: string, manifest: Manifest): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  const tmp = `${manifestPath(runId)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  await rename(tmp, manifestPath(runId));
}

/**
 * Highest version number present on disk for this type, or 0 if none.
 * Version allocation must survive manifest corruption: if the manifest is
 * lost/unparsable, allocating from manifest length alone would restart at v1
 * and overwrite existing artifact files.
 */
async function maxVersionOnDisk(
  runId: string,
  type: ArtifactType,
): Promise<number> {
  try {
    const files = await readdir(typeDir(runId, type));
    let max = 0;
    for (const f of files) {
      const m = /^v(\d+)\.json$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
}

function generateArtifactId(): string {
  return randomUUID();
}

export class FilesystemArtifactStore implements ArtifactStore {
  async save<T>(
    runId: string,
    type: ArtifactType,
    value: T,
    meta: Record<string, unknown>,
    status:
      "pending" | "complete" | "failed" | "invalid" | "superseded" = "pending",
  ): Promise<ArtifactReference> {
    return withLock(`save:${runId}`, async () => {
      const manifest = await readManifest(runId);
      const typeManifest = manifest[type] ?? { latest: "", versions: [] };
      const nextVersion =
        Math.max(
          typeManifest.versions.length,
          await maxVersionOnDisk(runId, type),
        ) + 1;
      const artifactId = generateArtifactId();
      const createdAt = new Date().toISOString();

      const record: ArtifactRecord<T> = {
        schemaVersion: 1,
        artifactId,
        type,
        version: nextVersion,
        status,
        createdAt,
        meta: meta as ArtifactMeta,
        data: value,
      };

      const dir = typeDir(runId, type);
      await ensureDir(dir);

      const tmp = `${artifactPath(runId, type, nextVersion)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
      await rename(tmp, artifactPath(runId, type, nextVersion));

      const entry: ManifestEntry = {
        version: nextVersion,
        status,
        createdAt,
        inputHash: (meta.inputHash as string) ?? "",
        artifactId,
      };

      typeManifest.latest = `v${nextVersion}`;
      typeManifest.versions.push(entry);
      manifest[type] = typeManifest;

      await writeManifest(runId, manifest);

      return {
        artifactId,
        type,
        version: nextVersion,
        location: artifactPath(runId, type, nextVersion),
        runId,
      };
    });
  }

  async load<T>(ref: ArtifactReference): Promise<ArtifactRecord<T> | null> {
    try {
      const content = await readFile(ref.location, "utf-8");
      return JSON.parse(content) as ArtifactRecord<T>;
    } catch {
      return null;
    }
  }

  async exists(runId: string, type: ArtifactType): Promise<boolean> {
    try {
      const manifest = await readManifest(runId);
      return !!manifest[type]?.latest;
    } catch {
      return false;
    }
  }

  async latest<T>(
    runId: string,
    type: ArtifactType,
  ): Promise<ArtifactRecord<T> | null> {
    const manifest = await readManifest(runId);
    const typeManifest = manifest[type];
    if (!typeManifest?.latest) return null;

    const version = Number(typeManifest.latest.replace("v", ""));
    if (!Number.isInteger(version) || version <= 0) return null;

    const entry = typeManifest.versions.find((v) => v.version === version);
    const ref: ArtifactReference = {
      artifactId: entry?.artifactId ?? "",
      type,
      version,
      location: artifactPath(runId, type, version),
      runId,
    };

    return this.load(ref);
  }

  async findCompleteByInputHash<T>(
    runId: string,
    type: ArtifactType,
    inputHash: string,
  ): Promise<{ record: ArtifactRecord<T>; ref: ArtifactReference } | null> {
    const versions = await this.listVersions(runId, type);
    for (const entry of [...versions].sort((a, b) => b.version - a.version)) {
      if (entry.status !== "complete" || entry.inputHash !== inputHash) {
        continue;
      }

      const ref: ArtifactReference = {
        artifactId: entry.artifactId,
        type,
        version: entry.version,
        location: artifactPath(runId, type, entry.version),
        runId,
      };
      const record = await this.load<T>(ref);
      if (
        record?.status === "complete" &&
        record.meta.inputHash === inputHash
      ) {
        return { record, ref };
      }
    }
    return null;
  }

  async listVersions(
    runId: string,
    type: ArtifactType,
  ): Promise<
    Array<{
      version: number;
      status: string;
      createdAt: string;
      artifactId: string;
      inputHash: string;
    }>
  > {
    const manifest = await readManifest(runId);
    const typeManifest = manifest[type];
    if (!typeManifest) return [];
    return typeManifest.versions;
  }

  async getManifest(runId: string): Promise<Manifest | null> {
    const manifest = await readManifest(runId);
    return Object.keys(manifest).length > 0 ? manifest : null;
  }

  async markStatus(
    runId: string,
    type: ArtifactType,
    version: number,
    status: "pending" | "complete" | "failed" | "invalid" | "superseded",
  ): Promise<void> {
    await withLock(`save:${runId}`, async () => {
      const manifest = await readManifest(runId);
      const typeManifest = manifest[type];
      if (!typeManifest) return;

      const idx = typeManifest.versions.findIndex((v) => v.version === version);
      if (idx < 0) return;

      typeManifest.versions[idx].status = status;

      if (status === "complete") {
        typeManifest.latest = `v${version}`;
      } else if (typeManifest.latest === `v${version}`) {
        for (let i = typeManifest.versions.length - 1; i >= 0; i--) {
          if (typeManifest.versions[i].status === "complete") {
            typeManifest.latest = `v${typeManifest.versions[i].version}`;
            break;
          }
        }
      }

      await writeManifest(runId, manifest);

      const ref: ArtifactReference = {
        artifactId: typeManifest.versions[idx].artifactId,
        type,
        version,
        location: artifactPath(runId, type, version),
        runId,
      };

      const record = await this.load(ref);
      if (record) {
        record.status = status;
        const tmp = `${ref.location}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
        await rename(tmp, ref.location);
      }
    });
  }

  async recordRef(runId: string, ref: ArtifactReference): Promise<void> {
    await withLock(`refs:${runId}`, async () => {
      const execPath = join(runDir(runId), "state", "execution.json");
      let execRefs: Record<string, ArtifactReference> = {};
      try {
        const content = await readFile(execPath, "utf-8");
        execRefs = JSON.parse(content) as Record<string, ArtifactReference>;
      } catch {
        execRefs = {};
      }
      execRefs[`${ref.type}@v${ref.version}`] = ref;
      const dir = dirname(execPath);
      await ensureDir(dir);
      const tmp = `${execPath}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(execRefs, null, 2), "utf-8");
      await rename(tmp, execPath);
    });
  }

  getRunId(
    config: Record<string, unknown>,
    state?: { execution?: { runId?: string }; project?: { topic?: string; pillar?: string } },
  ): string | null {
    if (config.runId && typeof config.runId === "string") return config.runId;
    if (config.thread_id && typeof config.thread_id === "string") {
      const topic =
        state?.project?.topic ??
        (typeof config.topic === "string" ? config.topic : undefined);
      const pillar = state?.project?.pillar;
      return resolveRunNamespace(config.thread_id, topic, pillar);
    }
    if (state?.execution?.runId) return state.execution.runId;
    return null;
  }
}

export function createArtifactStore(): FilesystemArtifactStore {
  return new FilesystemArtifactStore();
}
