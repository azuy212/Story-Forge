// Sheet snapshot router.
//
// Shells out to apps/orchestrator/scripts/sheet-read.mjs and caches the
// result in memory for a short TTL. The orchestrator already owns the
// googleapis + OAuth env, so we don't add googleapis to admin-ui's deps.
//
// Returned payload is parsed JSON from the script's stdout. Cache is keyed
// by profile so the next-in-line card on Launch can hit the short sheet
// without refetching the long sheet.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_UI_ROOT = join(__dirname, "..", "..");
const ORCHESTRATOR_ROOT = join(ADMIN_UI_ROOT, "..", "orchestrator");
const SCRIPT = join(ORCHESTRATOR_ROOT, "scripts", "sheet-read.mjs");

const TTL_MS = 15_000;
const MAX_AGE_MS = 60_000;

const cache = new Map();
const inFlight = new Map();

function fresh(entry) {
  return entry && Date.now() - entry.fetchedAt < TTL_MS;
}

function freshOrStale(entry) {
  return entry && Date.now() - entry.fetchedAt < MAX_AGE_MS;
}

async function readProcess({ profile }) {
  return new Promise((resolve, reject) => {
    const args = profile ? ["--profile", profile] : [];
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ORCHESTRATOR_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `sheet-read exited ${code}`));
        return;
      }
      try {
        // Strip any leading banner lines (e.g. dotenv v17+) so the JSON
        // parser only sees the JSON object.
        const jsonStart = stdout.search(/[\[{]/);
        const json = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
        resolve(JSON.parse(json));
      } catch (e) {
        reject(new Error(`sheet-read returned invalid JSON: ${e.message}`));
      }
    });
  });
}

async function getSnapshot(profile) {
  const key = profile ?? "all";
  const entry = cache.get(key);
  if (fresh(entry)) return entry.data;
  if (inFlight.has(key)) return inFlight.get(key);

  const task = readProcess({ profile })
    .then((data) => {
      const wrapped = { data, fetchedAt: Date.now() };
      cache.set(key, wrapped);
      return wrapped;
    })
    .catch((e) => {
      // Keep stale data on transient failure so the UI doesn't blank out on
      // a sheet hiccup; the entry's fetchedAt still tells the client how old
      // it is.
      if (freshOrStale(entry)) {
        return { data: entry.data, fetchedAt: entry.fetchedAt, staleError: e.message };
      }
      throw e;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

export async function sheetsRouter(app) {
  app.get("/", async (req) => {
    const profile = typeof req.query.profile === "string" ? req.query.profile : "";
    if (profile && profile !== "short" && profile !== "long") {
      return { error: "invalid_profile" };
    }
    try {
      const { data, fetchedAt, staleError } = await getSnapshot(profile || undefined);
      return { ...data, fetchedAt, stale: Boolean(staleError), staleError: staleError ?? null };
    } catch (e) {
      return { error: "sheet_read_failed", message: e.message };
    }
  });
}