import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PROMPTS_ROOT = resolve(process.cwd(), "prompts");
const cache = new Map<string, string>();

export async function loadPrompt(agentPath: string): Promise<string> {
  const filePath = resolve(PROMPTS_ROOT, agentPath);
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  const content = await readFile(filePath, "utf-8");
  cache.set(filePath, content);
  return content;
}
