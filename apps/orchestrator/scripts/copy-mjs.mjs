#!/usr/bin/env node
// tsc does not emit .mjs files. Copy them from src/ to dist/ preserving the
// relative tree so compiled modules that import a sibling .mjs can resolve
// it at runtime. Without this, namespace.js (and any other TS that imports
// ../foo.mjs) throws ERR_MODULE_NOT_FOUND when the launcher runs.
import { readdir, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const DST = join(ROOT, "dist");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const files = await walk(SRC);
  for (const src of files) {
    const rel = relative(SRC, src);
    const dst = join(DST, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
  // Patch the compiled namespace.js (and any other emitted .js) to import
  // the .mjs as a sibling .mjs (it already is), but ensure the file exists
  // alongside it. The import path is already correct relative to dist/.
  process.stdout.write(`copied ${files.length} .mjs file(s) to dist/\n`);
}

main().catch((err) => {
  console.error("copy-mjs failed:", err);
  process.exit(1);
});
