import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, basename } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
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
  summarizeLlmCost,
  STAGE_ORDER,
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

function watchForNewNamespace(before, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const now = listNamespaces();
      const fresh = now.filter((n) => !before.includes(n));
      if (fresh.length > 0) {
        resolve(fresh[0]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
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
    return ns
      .map(summarizeRun)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
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
    const llmCost = summarizeLlmCost(ns);
    return {
      ns,
      meta,
      manifest,
      stages,
      status,
      childStatus: child?.status ?? null,
      logSize: logSize(ns),
      llmCost,
    };
  });

  app.get("/runs/:ns/log", async (req, reply) => {
    const { ns } = req.params;
    const from = Number(req.query.from ?? 0);
    const tail = readLogTail(ns, from, 1024 * 1024);
    return { lines: tail.lines, nextOffset: tail.nextOffset };
  });

  app.get("/runs/:ns/assets", async (req, reply) => {
    const { ns } = req.params;
    const meta = readRunMeta(ns);
    if (!meta) return reply.code(404).send({ error: "run_not_found" });

    const manifest = readManifest(ns);
    const readArtifact = (type) => {
      const latest = manifest?.[type]?.latest;
      const filename = latest ? `${latest}.json` : "v1.json";
      const p = join(PATHS.RUNS, ns, "artifacts", type, filename);
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        return null;
      }
    };

    const toFileUrl = (p) => {
      if (!p) return null;
      const abs = isAbsolute(p) ? p : join(PATHS.RUNS, ns, p);
      if (!existsSync(abs)) return null;
      return `/api/orchestrator/file?path=${encodeURIComponent(abs)}`;
    };

    const assetsRec = readArtifact("assets");
    const scenes = (assetsRec?.data?.scenes ?? []).map((s) => ({
      sceneId: s.sceneId,
      assetUrl: toFileUrl(s.assetUrl ?? s.filename),
      filename: s.filename ?? s.assetUrl ?? null,
      provider: s.provider ?? null,
      generationStatus: s.generationStatus ?? null,
      generationMode: s.generationMode ?? null,
      durationSeconds: s.durationSeconds ?? null,
      narration: s.narration ?? null,
    }));

    const thumbRec = readArtifact("thumbnailImage");
    const thumbnail = thumbRec?.data
      ? {
          url: toFileUrl(thumbRec.data.imageUrl ?? thumbRec.data.sourceUrl),
          width: thumbRec.data.width,
          height: thumbRec.data.height,
          text: thumbRec.data.text,
        }
      : null;

    const audioRec = readArtifact("audio");
    const audio = audioRec?.data
      ? {
          combinedUrl: toFileUrl(
            audioRec.data.combinedAudio?.url ?? audioRec.data.narrationUrl,
          ),
          combinedDurationMs:
            audioRec.data.combinedAudio?.durationMs ??
            audioRec.data.narrationDurationMs,
          voice: audioRec.data.voice ?? null,
          scenes: (audioRec.data.scenes ?? []).map((a) => ({
            sceneId: a.sceneId,
            url: toFileUrl(a.url),
            durationMs: a.durationMs,
            narration: a.narration,
          })),
        }
      : null;

    const subRec = readArtifact("subtitles");
    const subtitles = subRec?.data
      ? {
          srt: subRec.data.srt ?? subRec.data.ass ?? null,
          format: subRec.data.srt ? "srt" : subRec.data.ass ? "ass" : null,
          cueCount: subRec.data.srt
            ? subRec.data.srt.split(/\r?\n\r?\n/).filter((b) => b.trim()).length
            : null,
          wordCount: Array.isArray(subRec.data.wordTimestamps)
            ? subRec.data.wordTimestamps.length
            : null,
        }
      : null;

    const vidRec = readArtifact("videoPlan");
    const video = vidRec?.data
      ? {
          url: toFileUrl(vidRec.data.videoUrl),
          durationMs: vidRec.data.durationMs ?? null,
          resolution: vidRec.data.resolution ?? null,
        }
      : null;

    const metaRec = readArtifact("metadata");
    const metadata = metaRec?.data
      ? {
          title: metaRec.data.title ?? null,
          description: metaRec.data.description ?? null,
          tags: metaRec.data.tags ?? null,
        }
      : null;

    return { ns, scenes, thumbnail, audio, subtitles, video, metadata };
  });

  app.get("/runs/:ns/artifacts/:type", async (req, reply) => {
    const { ns, type } = req.params;
    if (!readRunMeta(ns))
      return reply.code(404).send({ error: "run_not_found" });
    if (!STAGE_ORDER.includes(type))
      return reply.code(400).send({ error: "invalid_stage" });

    const manifest = readManifest(ns);
    const entry = manifest?.[type];
    const versions = (entry?.versions ?? []).map((v) => ({
      version: v.version,
      status: v.status ?? "unknown",
      createdAt: v.createdAt ?? null,
      artifactId: v.artifactId ?? null,
    }));

    const dir = join(PATHS.RUNS, ns, "artifacts", type);
    const readVersion = (n) => {
      const p = join(dir, `v${n}.json`);
      if (!existsSync(p)) return null;
      try {
        const stat = statSync(p);
        return {
          path: p,
          data: JSON.parse(readFileSync(p, "utf-8")),
          sizeBytes: stat.size,
        };
      } catch {
        return null;
      }
    };

    const pickLatest = () => {
      if (!entry?.latest) return null;
      const n = Number(String(entry.latest).replace("v", ""));
      if (!Number.isFinite(n)) return null;
      return (
        readVersion(n) ??
        versions
          .map((v) => v.version)
          .sort((a, b) => b - a)
          .map((n) => readVersion(n))
          .find((x) => x !== null) ??
        null
      );
    };

    const requestedVersion =
      req.query.version != null ? Number(req.query.version) : null;
    const picked =
      requestedVersion != null && Number.isFinite(requestedVersion)
        ? readVersion(requestedVersion)
        : pickLatest();
    const selectedVersion =
      requestedVersion != null && Number.isFinite(requestedVersion)
        ? requestedVersion
        : picked
          ? Number(String(entry?.latest ?? "").replace("v", "")) || null
          : null;
    return {
      ns,
      type,
      exists: picked !== null,
      version: selectedVersion,
      versions,
      artifact: picked?.data ?? null,
      sizeBytes: picked?.sizeBytes ?? null,
    };
  });

  app.delete("/runs/:ns/artifacts/:type", async (req, reply) => {
    const { ns, type } = req.params;
    if (!readRunMeta(ns))
      return reply.code(404).send({ error: "run_not_found" });
    if (!STAGE_ORDER.includes(type))
      return reply.code(400).send({ error: "invalid_stage" });
    if (get(ns)) return reply.code(409).send({ error: "run_active" });

    const dir = join(PATHS.RUNS, ns, "artifacts", type);
    let deleted = 0;
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f));
      deleted = files.length;
      rmSync(dir, { recursive: true, force: true });
    }

    const manifestPath = join(PATHS.RUNS, ns, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest && typeof manifest === "object" && type in manifest) {
          delete manifest[type];
          writeFileSync(
            manifestPath,
            JSON.stringify(manifest, null, 2),
            "utf-8",
          );
        }
      } catch {
        // manifest corrupted; filesystem delete is the source of truth
      }
    }

    const execPath = join(PATHS.RUNS, ns, "state", "execution.json");
    if (existsSync(execPath)) {
      try {
        const refs = JSON.parse(readFileSync(execPath, "utf-8"));
        if (refs && typeof refs === "object") {
          let changed = false;
          for (const k of Object.keys(refs)) {
            if (k.startsWith(`${type}@`)) {
              delete refs[k];
              changed = true;
            }
          }
          if (changed) {
            writeFileSync(execPath, JSON.stringify(refs, null, 2), "utf-8");
          }
        }
      } catch {
        // skip
      }
    }

    return { ok: true, ns, type, deleted };
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
    // run-next.mjs reads the sheet, picks a row, and creates the run dir
    // itself. We don't know the namespace up front, so we snapshot the
    // directory before spawn and watch for a new entry. Avoids pulling
    // googleapis into admin-ui's deps.
    const before = listNamespaces();
    const controller = makeController();
    register(`run-next-${Date.now()}`, controller);
    spawnScript(
      "run-next.mjs",
      [`--profile=${profile}`],
      `run-next-${Date.now()}`,
      () => {},
    );
    const ns = await watchForNewNamespace(before, 5000);
    if (!ns) {
      return { none: true, reason: "no-pending-row-or-no-slot" };
    }
    // Re-register under the real namespace so /stream and /cancel can find it.
    const meta = readRunMeta(ns);
    return { ns, action: meta?.threadHistory ? "resume" : "create", profile };
  });

  app.post("/launch/seed", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.seedPath)
      return reply.code(400).send({ error: "seed_path_required" });
    if (!existsSync(body.seedPath)) {
      return reply
        .code(400)
        .send({ error: "seed_file_not_found", path: body.seedPath });
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
      return reply
        .code(400)
        .send({ error: "seed_invalid", message: e.message });
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
    const { pillar, topic, videoProfile, projectId, youtubePublishAt } =
      req.body ?? {};
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
    if (!existsSync(dir))
      return reply.code(404).send({ error: "run_not_found" });
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
    if (!full.startsWith(root))
      return reply.code(400).send({ error: "bad_path" });
    if (!existsSync(full)) return reply.code(404).send({ error: "not_found" });
    return reply.sendFile(
      safe,
      root.endsWith(full) ? root : join(PATHS.RUNS, ns),
    );
  });

  app.get("/file", async (req, reply) => {
    const p = String(req.query.path ?? "");
    if (!p) return reply.code(400).send({ error: "path_required" });
    const abs = isAbsolute(p) ? p : join(PATHS.ORCHESTRATOR, p);
    const root = PATHS.ORCHESTRATOR;
    if (!abs.startsWith(root + "/") && abs !== root) {
      return reply.code(400).send({ error: "bad_path" });
    }
    if (!existsSync(abs)) return reply.code(404).send({ error: "not_found" });
    const stat = statSync(abs);
    if (!stat.isFile()) return reply.code(400).send({ error: "not_a_file" });
    return reply.sendFile(basename(abs), dirname(abs));
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
      const urlM = buf.match(
        /(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth[^\s]+)/,
      );
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
    if (!existsSync(envPath))
      return reply.code(404).send({ error: "env_not_found" });
    const backup = `${envPath}.bak`;
    copyFileSync(envPath, backup);
    let text = readFileSync(envPath, "utf-8");
    if (/^YOUTUBE_REFRESH_TOKEN=.*$/m.test(text)) {
      text = text.replace(
        /^YOUTUBE_REFRESH_TOKEN=.*$/m,
        `YOUTUBE_REFRESH_TOKEN=${token}`,
      );
    } else {
      text = text.trimEnd() + `\nYOUTUBE_REFRESH_TOKEN=${token}\n`;
    }
    writeFileSync(envPath, text, "utf-8");
    return { ok: true, backup };
  });

  app.get("/health", async () => {
    try {
      const r = await fetch(
        (process.env.LANGGRAPH_URL ?? "http://localhost:2024") +
          "/assistants/search",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      return { langgraph: r.ok ? "ok" : "degraded" };
    } catch (e) {
      return { langgraph: "down", error: e.message };
    }
  });
}
