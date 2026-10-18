import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The prompts live next to the package root, NOT relative to the process
// cwd: services and tests may run from any directory. Both `src/utils` and
// `dist/utils` sit two levels below the package root, so the module location
// is stable across dev (tsx) and production (dist) runs.
const PROMPTS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
);
const cache = new Map<string, string>();

export async function loadPrompt(agentPath: string): Promise<string> {
  const filePath = resolve(PROMPTS_ROOT, agentPath);
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  const content = await readFile(filePath, "utf-8");
  cache.set(filePath, content);
  return content;
}

/** Whether a prompt file exists under the loader's own prompts directory. */
export function promptFileExists(agentPath: string): boolean {
  return existsSync(resolve(PROMPTS_ROOT, agentPath));
}
