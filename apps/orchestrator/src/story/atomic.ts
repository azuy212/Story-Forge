import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Filesystem helpers for the story pipeline.
 *
 * Every artifact is written atomically (temp file in the same directory, then
 * rename) so a crash mid-write can never leave a half-written manifest or
 * scene asset that a later resume would mistake for a valid one.
 */

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, data);
  await rename(temp, path);
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function resolveFrom(base: string, path: string): string {
  return resolve(base, path);
}

/** Remove a possibly-missing file without throwing. */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}
