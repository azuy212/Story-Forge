import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, renameSync, statSync, readdirSync } from "node:fs";
import { createOrAppendRunMeta } from "../../../orchestrator/src/artifacts/run-meta.mjs";
import {
  listNamespaces,
  readRunMeta,
  readManifest,
  readLogTail,
  logSize,
  stageStatus,
  deriveRunStatus,
  summarizeRun,
  PATHS,
} from "../lib/runs.mjs";
import {
  makeController,
  register,
  attachChild,
  finish,
  get,
  list,
  cancel as cancelChild,
  spawnTracked,
} from "../lib/child.mjs";
import { sseHeaders, sseSend, sseComment, heartbeat } from "../lib/sse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(PATHS.ORCHESTRATOR, "scripts");

function spawnScript(script, args, ns, onEvent) {
  const child = spawnTracked({
    ns,
    command: process.execPath,
    args: [join(SCRIPT_PATH, script), ...args],
    cwd: PATHS.ORCHESTRATOR,
    onEvent,
  });
  return child;
}

async function precomputeRunNext(profile) {
  const m = await import(join(SCRIPT_PATH, "run-next.mjs"));
  const rows = await m.readSheetRows(
    await sheetsClient(),
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    profile === "long"
      ? process.env.GOOGLE_SHEETS_SHEET_NAME_LONG || "Long Videos"
      : process.env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1",
  );
  try {
    m.assertHeaders(rows);
  } catch (e) {
    return { error: e.message };
  }
  const decision = m.decideRun(PATHS.RUNS, rows, profile);
  if (decision.action === "none") {
    return {
      none: true,
      reason: decision.reason,
    };
  }
  return { decision };
}

async function sheetsClient() {
  const { default: googleapis } = await import("googleapis");
  const { google } = googleapis;
  const oauth2 = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.sheets({ version: "v4", auth: oauth2 });
}

function tailEmitter(ns, send, onClose) {
  let offset = logSize(ns);
  let closed = false;
  const tick = () => {
    if (closed) return;
    try {
      const size = logSize(ns);
      if (size > offset) {
        const { lines, nextOffset } = readLogTail(ns, offset, size - offset);
        offset = nextOffset;
        for (const ev of lines) send("log", ev);
      }
    } catch (e) {
      send("error", { message: e.message });
    }
  };
  const interval = setInterval(tick, 500);
  return () => {
    closed = true;
    clearInterval(interval);
    onClose?.();
  };
}

export async function orchestratorRouter(app) {
  app.get("/runs", async () => {
    const ns = listNamespaces();
    return ns.map(summarizeRun).sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    );
  });

  app.get("/runs/:ns", async (req, reply) => {
    const { ns } = req.params;
    const meta = readRunMeta(ns);
    if (!meta) return reply.code(404).send({ error: "run_not_found" });
    const manifest = readManifest(ns);
    const stages = stageStatus(manifest, meta.runSource === "seed");
    const logTail = readLogTail(ns, 0, 32 * 1024).lines;
    const status = deriveRunStatus(meta, manifest, logTail);
    const child = get(ns);
    return {
      ns,
      meta,
      manifest,
      stages,
      status,
      childStatus: child?.status ?? null,
      logSize: logSize(ns),
    };
  });

  app.get("/runs/:ns/log", async (req, reply) => {
    const { ns } = req.params;
    const from = Number(req.query.from ?? 0);
    const tail = readLogTail(ns, from, 1024 * 1024);
    return { lines: tail.lines, nextOffset: tail.nextOffset };
  });

  app.get("/runs/:ns/stream", async (req, reply) => {
    const { ns } = req.params;
    sseHeaders(reply);
    const stop = heartbeat(reply);
    const stopTail = tailEmitter(ns, (ev, data) => sseSend(reply, ev, data));
    const child = get(ns);
    if (child) {
      sseSend(reply, "child", {
        status: child.status,
        startedAt: child.startedAt,
        finishedAt: child.finishedAt,
      });
    }
    req.raw.on("close", () => {
      stop();
      stopTail();
    });
  });

  app.post("/launch/run-next", async (req, reply) => {
    const profile = req.body?.profile ?? "short";
    if (profile !== "short" && profile !== "long") {
      return reply.code(400).send({ error: "invalid_profile" });
    }
    const pre = await precomputeRunNext(profile);
    if (pre.error) return reply.code(400).send({ error: pre.error });
    if (pre.none) {
      return {
        none: true,
        reason: pre.reason,
      };
    }
    const decision = pre.decision;
    const controller = makeController();
    register(decision.ns, controller);
    const child = spawnScript(
      "run-next.mjs",
      [`--profile=${profile}`],
      decision.ns,
      (ev) => {
        if (ev.event === "stderr") sseSend(reply.raw, "stderr", { data: ev.data });
      },
    );
    return { ns: decision.ns, action: decision.action, profile, decision };
  });

  app.post("/launch/seed", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.seedPath) return reply.code(400).send({ error: "seed_path_required" });
    if (!existsSync(body.seedPath)) {
      return reply.code(400).send({ error: "seed_file_not_found", path: body.seedPath });
    }
    const m = await import(join(SCRIPT_PATH, "seed-build.mjs"));
    const { buildSeed } = m;
    const raw = JSON.parse(readFileSync(body.seedPath, "utf-8"));
    let built;
    try {
      built = buildSeed(raw, {
        pillar: body.pillar,
        topic: body.topic,
        profile: body.profile,
      });
    } catch (e) {
      return reply.code(400).send({ error: "seed_invalid", message: e.message });
    }
    const ns = `seed-${Date.now()}-${built.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)}`;
    const controller = makeController();
    register(ns, controller);
    const args = [`--seed=${body.seedPath}`];
    if (body.pillar) args.push(`--pillar=${body.pillar}`);
    if (body.topic) args.push(`--topic=${body.topic}`);
    if (body.profile) args.push(`--profile=${body.profile}`);
    if (body.publishAt) args.push(`--publish-at=${body.publishAt}`);
    if (body.projectId) args.push(`--project-id=${body.projectId}`);
    if (body.convert === true) args.push("--convert");
    if (body.convert === false) args.push("--no-convert");
    if (body.dryRun) args.push("--dry-run");
    spawnScript("seed-run.mjs", args, ns, () => {});
    return { ns, action: "create", profile: built.videoProfile };
  });

  app.post("/runs/:ns/resume", async (req, reply) => {
    const { ns } = req.params;
    const meta = readRunMeta(ns);
    if (!meta) return reply.code(404).send({ error: "run_not_found" });
    const body = req.body ?? {};
    const args = [ns];
    if (body.pillar) args.push(`--pillar=${body.pillar}`);
    if (body.topic) args.push(`--topic=${body.topic}`);
    if (body.profile) args.push(`--profile=${body.profile}`);
    if (body.seed) args.push(`--seed=${body.seed}`);
    if (body.dryRun) args.push("--dry-run");
    const controller = makeController();
    register(ns, controller);
    spawnScript("resume.mjs", args, ns, () => {});
    return { ns, action: "resume" };
  });

  app.post("/runs/:ns/cancel", async (req) => {
    const { ns } = req.params;
    const ok = cancelChild(ns);
    return { ok, ns };
  });

  app.post("/runs/:ns/abort", async (req) => {
    const { ns } = req.params;
    const meta = readRunMeta(ns);
    if (!meta) return { ok: false, error: "run_not_found" };
    cancelChild(ns);
    const path = join(PATHS.RUNS, ns, "run.json");
    const next = { ...meta, abortedAt: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
    return { ok: true };
  });

  app.patch("/runs/:ns", async (req, reply) => {
    const { ns } = req.params;
    const meta = readRunMeta(ns);
    if (!meta) return reply.code(404).send({ error: "run_not_found" });
    const { pillar, topic, videoProfile, projectId, youtubePublishAt } = req.body ?? {};
    const path = join(PATHS.RUNS, ns, "run.json");
    const next = {
      ...meta,
      ...(pillar !== undefined ? { pillar } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(videoProfile !== undefined ? { videoProfile } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(youtubePublishAt !== undefined ? { youtubePublishAt } : {}),
    };
    writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
    return { ok: true, meta: next };
  });

  app.delete("/runs/:ns", async (req, reply) => {
    const { ns } = req.params;
    const dir = join(PATHS.RUNS, ns);
    if (!existsSync(dir)) return reply.code(404).send({ error: "run_not_found" });
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  });

  app.get("/files/:ns/*", async (req, reply) => {
    const { ns } = req.params;
    const rest = req.params["*"];
    if (!rest) return reply.code(400).send({ error: "path_required" });
    const safe = rest.replace(/\.\.+/g, "");
    const full = join(PATHS.RUNS, ns, safe);
    const root = join(PATHS.RUNS, ns);
    if (!full.startsWith(root)) return reply.code(400).send({ error: "bad_path" });
    if (!existsSync(full)) return reply.code(404).send({ error: "not_found" });
    return reply.sendFile(safe, root.endsWith(full) ? root : join(PATHS.RUNS, ns));
  });

  app.get("/active", async () => list());

  app.post("/auth/youtube/start", async (req, reply) => {
    const id = `oauth-${Date.now()}`;
    register(id, makeController());
    const child = spawnScript("oauth-youtube.mjs", [], id, (ev) => {
      if (ev.event === "stderr") console.log(`[oauth] ${ev.data}`);
    });
    let buf = "";
    let captured = null;
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const m = buf.match(/Refresh token:\s*\n+([A-Za-z0-9_\-]+)/);
      if (m) captured = m[1];
      const urlM = buf.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth[^\s]+)/);
      if (urlM && !reply.sent) {
        reply.sent = true;
        reply.send({ id, authUrl: urlM[1] });
      }
    });
    child.on("exit", (code) => {
      if (captured) {
        finish(id, code === 0 ? "complete" : "failed");
        return;
      }
      finish(id, code === 0 ? "complete" : "failed");
    });
    return reply;
  });

  app.post("/auth/youtube/save", async (req, reply) => {
    const { token } = req.body ?? {};
    if (!token) return reply.code(400).send({ error: "token_required" });
    const envPath = PATHS.ORCH_ENV;
    if (!existsSync(envPath)) return reply.code(404).send({ error: "env_not_found" });
    const backup = `${envPath}.bak`;
    copyFileSync(envPath, backup);
    let text = readFileSync(envPath, "utf-8");
    if (/^YOUTUBE_REFRESH_TOKEN=.*$/m.test(text)) {
      text = text.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, `YOUTUBE_REFRESH_TOKEN=${token}`);
    } else {
      text = text.trimEnd() + `\nYOUTUBE_REFRESH_TOKEN=${token}\n`;
    }
    writeFileSync(envPath, text, "utf-8");
    return { ok: true, backup };
  });

  app.get("/health", async () => {
    try {
      const r = await fetch(
        (process.env.LANGGRAPH_URL ?? "http://localhost:2024") + "/assistants/search",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      return { langgraph: r.ok ? "ok" : "degraded" };
    } catch (e) {
      return { langgraph: "down", error: e.message };
    }
  });
}
