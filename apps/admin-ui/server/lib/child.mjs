import { spawn } from "node:child_process";

const REGISTRY = new Map();

export function register(ns, controller, child = null) {
  REGISTRY.set(ns, {
    controller,
    child,
    startedAt: Date.now(),
    status: "running",
    lastError: null,
  });
}

export function attachChild(ns, child) {
  const entry = REGISTRY.get(ns);
  if (entry) entry.child = child;
  else REGISTRY.set(ns, { controller: null, child, startedAt: Date.now(), status: "running" });
}

export function finish(ns, status, lastError = null) {
  const entry = REGISTRY.get(ns);
  if (entry) {
    entry.status = status;
    entry.lastError = lastError;
    entry.finishedAt = Date.now();
    if (entry.controller) entry.controller.aborted = true;
  }
}

export function get(ns) {
  return REGISTRY.get(ns) ?? null;
}

export function list() {
  return [...REGISTRY.entries()].map(([ns, v]) => ({ ns, ...v }));
}

export function cancel(ns) {
  const entry = REGISTRY.get(ns);
  if (!entry) return false;
  try {
    entry.controller?.abort?.();
  } catch {
    // already aborted
  }
  if (entry.child && !entry.child.killed) {
    try {
      entry.child.kill("SIGTERM");
    } catch {
      // process already exited
    }
  }
  entry.status = "cancelled";
  return true;
}

export function makeController() {
  const c = new AbortController();
  c.aborted = false;
  return c;
}

export function spawnTracked({ ns, command, args, cwd, env, onEvent }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachChild(ns, child);
  let buf = "";
  const handle = (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        onEvent?.(event);
      } catch {
        // malformed SSE line — skip
      }
    }
  };
  child.stdout.on("data", handle);
  child.stderr.on("data", (c) => onEvent?.({ event: "stderr", data: c.toString("utf-8") }));
  child.on("exit", (code, signal) => {
    finish(ns, signal === "SIGTERM" ? "cancelled" : code === 0 ? "complete" : "failed");
  });
  child.on("error", (err) => {
    finish(ns, "failed", err.message);
  });
  return child;
}
