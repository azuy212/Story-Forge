import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { slugify } from "../utils/slugify.js";

/**
 * Human-readable run namespace resolution.
 *
 * A run's filesystem namespace is never the raw LangGraph thread_id (a UUID).
 * Instead it resolves to `slug-YYYYMMDD-HHmmss-xxxx` (e.g.
 * `unrecognized-countries-20260813-084203-a1b2`), derived from the project
 * topic when known. Resolution is stable per run:
 *
 *  1. in-process memo (first resolution wins, whole run consistent)
 *  2. disk index `runs/.run-names/<sanitized-thread-id>` (cross-process
 *     continuity: resuming the same thread_id in a fresh process reuses the
 *     same directory)
 *  3. fresh generation, persisted via atomic `wx` create so concurrent
 *     processes cannot overwrite an established mapping.
 *
 * The thread_id itself is untouched; only the filesystem namespace changes.
 */

const DEFAULT_RUNS_DIR = join(process.cwd(), "runs");
const NAMESPACE_INDEX_DIR = ".run-names";

const memo = new Map<string, string>();
const unnamedMemo = new Map<string, string>();

export function getRunsDir(): string {
  return process.env.ARTIFACT_STORE_DIR ?? DEFAULT_RUNS_DIR;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Compact timestamp `YYYYMMDD-HHmmss` in the process's LOCAL time. Local
 * time is intentional for human-readable directory names; the disk index
 * keeps an existing thread's namespace stable across processes and
 * timezones, so the stamp only affects freshly generated names.
 */
export function formatRunStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function randomSuffix(): string {
  return randomBytes(2).toString("hex");
}

function buildName(topic?: string): string {
  const slug = slugify(topic ?? "untitled");
  return `${slug}-${formatRunStamp(new Date())}-${randomSuffix()}`;
}

/**
 * Thread_id is used only as a lookup key in the index; the raw value is
 * never embedded in a path without sanitization.
 */
function sanitizeKey(threadId: string): string {
  return threadId.replace(/[^a-z0-9-_.]+/gi, "_");
}

function indexPath(threadId: string): string {
  return join(getRunsDir(), NAMESPACE_INDEX_DIR, sanitizeKey(threadId));
}

function readDisk(threadId: string): string | null {
  try {
    return readFileSync(indexPath(threadId), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Atomically claim the index entry. On EEXIST (another process won the race)
 * fall back to the winner's entry; the winning write is synchronous, so if it
 * is not readable the mapping cannot be used and the error propagates (fail
 * closed) instead of silently generating a different name. Non-EEXIST
 * failures rethrow so namespace failures stay visible.
 */
function claimDisk(threadId: string, name: string): string {
  mkdirSync(join(getRunsDir(), NAMESPACE_INDEX_DIR), { recursive: true });

  try {
    writeFileSync(indexPath(threadId), name, { flag: "wx" });
    return name;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const winner = readDisk(threadId);
    if (winner) return winner;

    throw new Error(
      `namespace index entry for ${sanitizeKey(threadId)} is claimed but unreadable`,
      { cause: error },
    );
  }
}

export function resolveRunNamespace(threadId: string, topic?: string): string {
  const memoized = memo.get(threadId);
  if (memoized) return memoized;

  const disk = readDisk(threadId);
  if (disk) {
    memo.set(threadId, disk);
    return disk;
  }

  const name = claimDisk(threadId, buildName(topic));
  memo.set(threadId, name);
  return name;
}

/**
 * Namespace for direct node invocations with no thread_id. Memoized per raw
 * topic (a special key for undefined) so all nodes in one such run agree on a
 * single directory; not persisted to disk (there is no stable key).
 */
export function resolveUnnamedRun(topic?: string): string {
  const key = topic ?? "__untitled__";
  const existing = unnamedMemo.get(key);
  if (existing) return existing;
  const name = buildName(topic);
  unnamedMemo.set(key, name);
  return name;
}

export function resetRunNamespaces(): void {
  memo.clear();
  unnamedMemo.clear();
}
