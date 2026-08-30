export type RunStatus = "new" | "running" | "incomplete" | "failed" | "published" | "aborted";

export type RunSummary = {
  ns: string;
  topic: string | null;
  pillar: string | null;
  videoProfile: string | null;
  runSource: string;
  projectId: string | null;
  youtubePublishAt: string | null;
  createdAt: string | null;
  threadHistory: string[];
  hasSeed: boolean;
  abortedAt: string | null;
  status: RunStatus;
};

export type StageStatus = "complete" | "seeded" | "missing" | "pending" | "failed" | "unknown";

export type RunDetail = {
  ns: string;
  meta: Record<string, unknown>;
  manifest: Record<string, unknown> | null;
  stages: Record<string, StageStatus>;
  status: RunStatus;
  childStatus: string | null;
  logSize: number;
};

export type LogEvent = Record<string, unknown> & { event: string; ts?: number };

export type LogTail = { lines: LogEvent[]; nextOffset: number };

export type ActiveChild = {
  ns: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  lastError?: string | null;
};

export type Health = Record<string, string>;

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

export const api = {
  health: () => jsonFetch<Health>("/api/orchestrator/health"),
  listRuns: () => jsonFetch<RunSummary[]>("/api/orchestrator/runs"),
  getRun: (ns: string) => jsonFetch<RunDetail>(`/api/orchestrator/runs/${encodeURIComponent(ns)}`),
  tailLog: (ns: string, from = 0) =>
    jsonFetch<LogTail>(`/api/orchestrator/runs/${encodeURIComponent(ns)}/log?from=${from}`),
  launchRunNext: (profile: "short" | "long") =>
    jsonFetch<{ ns: string; action: string; none?: boolean; reason?: string }>(
      "/api/orchestrator/launch/run-next",
      { method: "POST", body: JSON.stringify({ profile }) },
    ),
  launchSeed: (body: Record<string, unknown>) =>
    jsonFetch<{ ns: string; action: string }>("/api/orchestrator/launch/seed", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resumeRun: (ns: string, body: Record<string, unknown> = {}) =>
    jsonFetch<{ ns: string; action: string }>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/resume`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  cancelRun: (ns: string) =>
    jsonFetch<{ ok: boolean; ns: string }>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/cancel`,
      { method: "POST" },
    ),
  abortRun: (ns: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/abort`,
      { method: "POST" },
    ),
  patchRun: (ns: string, body: Record<string, unknown>) =>
    jsonFetch<{ ok: boolean; meta: Record<string, unknown> }>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  deleteRun: (ns: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}`,
      { method: "DELETE" },
    ),
  activeChildren: () => jsonFetch<ActiveChild[]>("/api/orchestrator/active"),

  oauthStart: () =>
    jsonFetch<{ id: string; authUrl: string }>("/api/orchestrator/auth/youtube/start", {
      method: "POST",
    }),
  oauthSave: (token: string) =>
    jsonFetch<{ ok: boolean; backup: string }>("/api/orchestrator/auth/youtube/save", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  imageProvider: {
    health: async () => {
      try {
        const r = await fetch("/api/image-provider/", { method: "GET" });
        return r.ok ? ("ok" as const) : ("down" as const);
      } catch {
        return "down" as const;
      }
    },
    generate: (body: { prompt: string; type?: "image" | "video"; count?: number }) =>
      jsonFetch<Record<string, unknown>>("/api/image-provider/generate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  tts: {
    health: async () => {
      try {
        const r = await fetch("/api/tts/");
        return r.ok ? ("ok" as const) : ("down" as const);
      } catch {
        return "down" as const;
      }
    },
    generate: (body: { text: string; voice?: string }) =>
      jsonFetch<Record<string, unknown>>("/api/tts/generate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  transcriber: {
    health: async () => {
      try {
        const r = await fetch("/api/transcriber/health");
        return r.ok ? ("ok" as const) : ("down" as const);
      } catch {
        return "down" as const;
      }
    },
    align: async (audio: File, text?: string) => {
      const fd = new FormData();
      fd.append("audio", audio);
      if (text) fd.append("text", text);
      const r = await fetch("/api/transcriber/align", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return r.json();
    },
  },
};
