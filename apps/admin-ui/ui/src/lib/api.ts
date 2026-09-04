export type RunStatus =
  "new" | "running" | "incomplete" | "failed" | "published" | "aborted";

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
  /** Total LLM cost in USD for the run, when the provider reported it. */
  llmCostUsd: number | null;
  /** Total number of LLM requests persisted for the run (all nodes). */
  llmRequestCount: number;
};

export type StageStatus =
  "complete" | "seeded" | "missing" | "pending" | "failed" | "unknown";

/**
 * Cost breakdown for one LLM call group (a stage node or a model). `costUsd`
 * is `null` when the group has records but none of them reported a cost —
 * the provider can refuse to report and we never fabricate a value.
 */
export type LlmCostBreakdownEntry = {
  costUsd: number | null;
  requests: number;
};

export type LlmCostSummary = {
  totalCostUsd: number | null;
  requestCount: number;
  perStage: Record<string, LlmCostBreakdownEntry>;
  perModel: Record<string, LlmCostBreakdownEntry>;
};

export type RunDetail = {
  ns: string;
  meta: Record<string, unknown>;
  manifest: Record<string, unknown> | null;
  stages: Record<string, StageStatus>;
  status: RunStatus;
  childStatus: string | null;
  logSize: number;
  llmCost: LlmCostSummary;
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

export type SceneAsset = {
  sceneId: number;
  assetUrl: string | null;
  filename: string | null;
  provider: string | null;
  generationStatus: string | null;
  generationMode: string | null;
  durationSeconds: number | null;
  narration: string | null;
};

export type SceneAudioT = {
  sceneId: number;
  url: string | null;
  durationMs: number;
  narration: string;
};

export type ThumbnailAsset = {
  url: string | null;
  width: number;
  height: number;
  text: string;
};

export type AudioAsset = {
  combinedUrl: string | null;
  combinedDurationMs: number | null;
  voice: string | null;
  scenes: SceneAudioT[];
};

export type SubtitlesAsset = {
  srt: string | null;
  format: "srt" | "ass" | null;
  cueCount: number | null;
  wordCount: number | null;
};

export type VideoAsset = {
  url: string | null;
  durationMs: number | null;
  resolution: string | null;
};

export type MetadataAsset = {
  title: string | null;
  description: string | null;
  tags: string[] | null;
};

export type AssetsPayload = {
  ns: string;
  scenes: SceneAsset[];
  thumbnail: ThumbnailAsset | null;
  audio: AudioAsset | null;
  subtitles: SubtitlesAsset | null;
  video: VideoAsset | null;
  metadata: MetadataAsset | null;
};

export type StageArtifactVersion = {
  version: number;
  status: string;
  createdAt: string | null;
  artifactId: string | null;
};

export type StageArtifact = {
  ns: string;
  type: string;
  exists: boolean;
  version: number | null;
  versions: StageArtifactVersion[];
  artifact: unknown;
  sizeBytes: number | null;
};

export type DeleteStageResult = {
  ok: true;
  ns: string;
  type: string;
  deleted: number;
};

export type Health = Record<string, string>;

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (hasBody && !("content-type" in headers) && !("Content-Type" in headers)) {
    headers["content-type"] = "application/json";
  }
  const r = await fetch(input, { ...init, headers });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

export const api = {
  health: () => jsonFetch<Health>("/api/orchestrator/health"),
  listRuns: () => jsonFetch<RunSummary[]>("/api/orchestrator/runs"),
  getRun: (ns: string) =>
    jsonFetch<RunDetail>(`/api/orchestrator/runs/${encodeURIComponent(ns)}`),
  tailLog: (ns: string, from = 0) =>
    jsonFetch<LogTail>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/log?from=${from}`,
    ),
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
  getAssets: (ns: string) =>
    jsonFetch<AssetsPayload>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/assets`,
    ),
  getStageArtifact: (ns: string, type: string, version?: number) => {
    const q = version != null ? `?version=${version}` : "";
    return jsonFetch<StageArtifact>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/artifacts/${encodeURIComponent(type)}${q}`,
    );
  },
  deleteStageArtifact: (ns: string, type: string) =>
    jsonFetch<DeleteStageResult>(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/artifacts/${encodeURIComponent(type)}`,
      { method: "DELETE" },
    ),

  oauthStart: () =>
    jsonFetch<{ id: string; authUrl: string }>(
      "/api/orchestrator/auth/youtube/start",
      {
        method: "POST",
      },
    ),
  oauthStatus: (id: string) =>
    jsonFetch<{
      authUrl?: string;
      refreshToken?: string;
      status?: "complete" | "failed";
      code?: number | null;
    }>(`/api/orchestrator/auth/youtube/status/${encodeURIComponent(id)}`),
  oauthSave: (token: string) =>
    jsonFetch<{ ok: boolean; backup: string }>(
      "/api/orchestrator/auth/youtube/save",
      {
        method: "POST",
        body: JSON.stringify({ token }),
      },
    ),

  imageProvider: {
    health: async () => {
      try {
        const r = await fetch("/api/image-provider/health", { method: "GET" });
        return r.ok ? ("ok" as const) : ("down" as const);
      } catch {
        return "down" as const;
      }
    },
    generate: (body: {
      prompt: string;
      type?: "image" | "video";
      count?: number;
    }) =>
      jsonFetch<Record<string, unknown>>("/api/image-provider/generate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  tts: {
    health: async () => {
      try {
        const r = await fetch("/api/tts/health", { method: "GET" });
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
        const r = await fetch("/api/transcriber/health", { method: "GET" });
        return r.ok ? ("ok" as const) : ("down" as const);
      } catch {
        return "down" as const;
      }
    },
    align: async (audio: File, text?: string) => {
      const fd = new FormData();
      fd.append("audio", audio);
      if (text) fd.append("text", text);
      const r = await fetch("/api/transcriber/align", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return r.json();
    },
  },

  sheets: {
    fetch: (profile?: "short" | "long") => {
      const q = profile ? `?profile=${profile}` : "";
      return jsonFetch<Record<string, unknown>>(`/api/sheets${q}`);
    },
  },
};
