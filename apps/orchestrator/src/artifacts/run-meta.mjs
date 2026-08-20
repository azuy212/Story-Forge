import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

export function runMetaPath(runsDir, runId) {
  return join(runsDir, runId, "run.json");
}

function freshMeta({ threadId, topic, pillar, projectId }) {
  return {
    threadId,
    topic,
    pillar,
    // Backlog identity: ties a run to its Google Sheets row (Video ID).
    ...(projectId ? { projectId } : {}),
    createdAt: new Date().toISOString(),
    threadHistory: [threadId],
  };
}

function writeAtomic(path, meta) {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
  renameSync(tmp, path);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isStaleLock(lockDir) {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf-8"),
    );
    if (owner.pid && !pidAlive(owner.pid)) return true;
    if (Date.now() - owner.createdAt > LOCK_STALE_MS) return true;
    return false;
  } catch {
    const stat = statSync(lockDir);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  }
}

/**
 * Atomically reclaim a stale lock by renaming it to a unique quarantine
 * directory. Only the process whose rename succeeds owns the reclaim; a
 * contender that lost the rename (ENOENT) just retries acquisition. This
 * avoids the TOCTOU where two processes both observe the stale lock and one
 * deletes the other's freshly acquired lock.
 */
function reclaimStaleLock(lockDir) {
  const quarantine = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockDir, quarantine);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function withLock(path, fn) {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        "utf-8",
      );
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (isStaleLock(lockDir) && reclaimStaleLock(lockDir)) {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockDir}`, {
          cause: err,
        });
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        LOCK_RETRY_MS,
      );
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // lock already released
    }
  }
}

/**
 * Atomically create `run.json` for a run, or append `threadId` to its
 * threadHistory if it already exists.
 *
 * The whole read/create/update runs under a lock directory, so concurrent
 * callers serialize: no reader can observe a partially written file and no
 * read-modify-write can drop a threadId. Every write is atomic
 * (tmp file + rename). Original topic/pillar/createdAt are preserved on
 * append.
 *
 * @param {string} runsDir artifact store root
 * @param {string} runId run folder name
 * @param {{ threadId: string, topic: string, pillar?: string, projectId?: string }} meta
 * @returns {object} the persisted run.json content
 */
export function createOrAppendRunMeta(runsDir, runId, meta) {
  const path = runMetaPath(runsDir, runId);
  mkdirSync(join(runsDir, runId), { recursive: true });

  return withLock(path, () => {
    if (!existsSync(path)) {
      const initial = freshMeta(meta);
      writeAtomic(path, initial);
      return initial;
    }

    const existing = JSON.parse(readFileSync(path, "utf-8"));

    if (!existing.threadHistory.includes(meta.threadId)) {
      existing.threadHistory.push(meta.threadId);
      writeAtomic(path, existing);
    }

    return existing;
  });
}
