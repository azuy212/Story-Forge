import { useEffect, useState, useMemo } from "react";
import { api, type LogEvent, type RunDetail as RunDetailT, type RunStatus } from "../api";
import { StageGrid } from "../components/StageGrid";
import { LogStream } from "../components/LogStream";
import { ProgressBar, type NodeStatus } from "../components/ProgressBar";

const STATUS_COLOR: Record<RunStatus, string> = {
  new: "bg-zinc-700 text-zinc-200",
  running: "bg-cyan-700 text-cyan-100",
  incomplete: "bg-amber-700 text-amber-100",
  failed: "bg-rose-700 text-rose-100",
  published: "bg-emerald-700 text-emerald-100",
  aborted: "bg-zinc-600 text-zinc-300",
};

type Props = { ns: string; onBack: () => void };

export function RunDetail({ ns, onBack }: Props) {
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    pillar: "",
    topic: "",
    videoProfile: "short",
    projectId: "",
    youtubePublishAt: "",
  });
  const [resumeOverrides, setResumeOverrides] = useState({
    open: false,
    pillar: "",
    topic: "",
    profile: "short",
    seed: "",
    dryRun: false,
  });
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getRun(ns)
        .then((d) => {
          if (!alive) return;
          setDetail(d);
          setEditForm({
            pillar: (d.meta.pillar as string) ?? "",
            topic: (d.meta.topic as string) ?? "",
            videoProfile: (d.meta.videoProfile as string) ?? "short",
            projectId: (d.meta.projectId as string) ?? "",
            youtubePublishAt: (d.meta.youtubePublishAt as string) ?? "",
          });
        })
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ns]);

  const [initialLog, setInitialLog] = useState<LogEvent[]>([]);
  useEffect(() => {
    let alive = true;
    api.tailLog(ns, 0).then((t) => {
      if (alive) setInitialLog(t.lines);
    });
    return () => {
      alive = false;
    };
  }, [ns]);

  const [logEvents, setLogEvents] = useState<LogEvent[]>(initialLog);
  useEffect(() => {
    setLogEvents(initialLog);
  }, [initialLog]);

  const nodeStates = useMemo(() => {
    const states: Record<string, NodeStatus> = {};
    for (const ev of logEvents) {
      if (ev.event === "node_start") {
        const n = ev.node as string | undefined;
        if (n) states[n] = "running";
      } else if (ev.event === "node_end") {
        const n = ev.node as string | undefined;
        if (n) states[n] = "complete";
      } else if (ev.event === "node_failed") {
        const n = ev.node as string | undefined;
        if (n) states[n] = "failed";
      }
    }
    return states;
  }, [logEvents]);

  const streamUrl = `/api/orchestrator/runs/${encodeURIComponent(ns)}/stream`;

  async function withAction(fn: () => Promise<unknown>, msg: string) {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(`${msg}: ${(e as Error).message}`);
    }
  }

  function onResume() {
    withAction(() => api.resumeRun(ns), "Resume failed");
  }
  function onResumeDry() {
    withAction(() => api.resumeRun(ns, { dryRun: true }), "Dry-run failed");
  }
  function onResumeWithOverrides() {
    const body: Record<string, unknown> = {};
    if (resumeOverrides.pillar) body.pillar = resumeOverrides.pillar;
    if (resumeOverrides.topic) body.topic = resumeOverrides.topic;
    if (resumeOverrides.profile) body.profile = resumeOverrides.profile;
    if (resumeOverrides.seed) body.seed = resumeOverrides.seed;
    if (resumeOverrides.dryRun) body.dryRun = true;
    withAction(
      () => api.resumeRun(ns, body).then(() => setResumeOverrides((s) => ({ ...s, open: false }))),
      "Resume failed",
    );
  }
  function onCancel() {
    if (!confirm(`Cancel running child for ${ns}?`)) return;
    withAction(() => api.cancelRun(ns), "Cancel failed");
  }
  function onAbort() {
    if (
      !confirm(
        `Mark ${ns} as aborted? Stops the child (if running) and writes abortedAt to run.json.`,
      )
    )
      return;
    withAction(() => api.abortRun(ns), "Abort failed");
  }
  function onSaveEdit() {
    const body: Record<string, unknown> = {
      pillar: editForm.pillar || null,
      topic: editForm.topic || null,
      videoProfile: editForm.videoProfile,
      projectId: editForm.projectId || null,
      youtubePublishAt: editForm.youtubePublishAt || null,
    };
    withAction(
      () => api.patchRun(ns, body).then(() => setEditing(false)),
      "Save failed",
    );
  }
  function onDelete() {
    if (!confirm(`Delete run ${ns}? This removes runs/${ns}/ permanently.`)) return;
    withAction(() => api.deleteRun(ns).then(onBack), "Delete failed");
  }

  if (error) {
    return (
      <div className="p-8 text-rose-400">
        <button onClick={onBack} className="text-cyan-400 underline mr-3">
          ← Runs
        </button>
        Error: {error}
      </div>
    );
  }
  if (!detail) {
    return <div className="p-8 text-zinc-400">Loading {ns}…</div>;
  }

  const meta = detail.meta;
  const threadHistory = (meta.threadHistory as string[] | undefined) ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-cyan-400 text-sm hover:underline">
            ← Runs
          </button>
          <h1 className="text-xl font-semibold mono text-cyan-300">{ns}</h1>
          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLOR[detail.status]}`}>
            {detail.status}
          </span>
          {detail.childStatus && (
            <span className="text-xs px-2 py-0.5 rounded bg-ink-800 text-zinc-400">
              child: {detail.childStatus}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onResume}
            className="text-sm px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600"
          >
            Resume
          </button>
          <button
            onClick={() => setResumeOverrides((s) => ({ ...s, open: !s.open }))}
            className="text-sm px-3 py-1.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
          >
            Resume…
          </button>
          <button
            onClick={onResumeDry}
            className="text-sm px-3 py-1.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
          >
            Dry-run
          </button>
          <button
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={onAbort}
            className="text-sm px-3 py-1.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
          >
            Abort
          </button>
          <button
            onClick={() => setEditing((e) => !e)}
            className="text-sm px-3 py-1.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="text-sm px-3 py-1.5 rounded bg-rose-700 hover:bg-rose-600"
          >
            Delete
          </button>
        </div>
      </div>

      {actionError && (
        <div className="text-rose-400 text-sm mb-3">Error: {actionError}</div>
      )}

      {resumeOverrides.open && (
        <div className="bg-ink-900 border border-zinc-700 rounded p-3 mb-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          <input
            placeholder="pillar override"
            value={resumeOverrides.pillar}
            onChange={(e) => setResumeOverrides((s) => ({ ...s, pillar: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <input
            placeholder="topic override"
            value={resumeOverrides.topic}
            onChange={(e) => setResumeOverrides((s) => ({ ...s, topic: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <select
            value={resumeOverrides.profile}
            onChange={(e) => setResumeOverrides((s) => ({ ...s, profile: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="short">short</option>
            <option value="long">long</option>
          </select>
          <input
            placeholder="--seed path (optional)"
            value={resumeOverrides.seed}
            onChange={(e) => setResumeOverrides((s) => ({ ...s, seed: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-zinc-300 col-span-2">
            <input
              type="checkbox"
              checked={resumeOverrides.dryRun}
              onChange={(e) => setResumeOverrides((s) => ({ ...s, dryRun: e.target.checked }))}
            />
            dry-run only
          </label>
          <div className="col-span-2 flex gap-2 justify-end">
            <button
              onClick={() => setResumeOverrides((s) => ({ ...s, open: false }))}
              className="text-xs px-2 py-1 rounded bg-ink-800 hover:bg-ink-700"
            >
              Cancel
            </button>
            <button
              onClick={onResumeWithOverrides}
              className="text-xs px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600"
            >
              Run
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="bg-ink-900 border border-zinc-700 rounded p-3 mb-4 grid grid-cols-2 md:grid-cols-5 gap-2">
          <input
            placeholder="pillar"
            value={editForm.pillar}
            onChange={(e) => setEditForm((s) => ({ ...s, pillar: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <input
            placeholder="topic"
            value={editForm.topic}
            onChange={(e) => setEditForm((s) => ({ ...s, topic: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <select
            value={editForm.videoProfile}
            onChange={(e) => setEditForm((s) => ({ ...s, videoProfile: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="short">short</option>
            <option value="long">long</option>
          </select>
          <input
            placeholder="projectId"
            value={editForm.projectId}
            onChange={(e) => setEditForm((s) => ({ ...s, projectId: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <input
            placeholder="youtubePublishAt (ISO 8601)"
            value={editForm.youtubePublishAt}
            onChange={(e) => setEditForm((s) => ({ ...s, youtubePublishAt: e.target.value }))}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <div className="col-span-2 md:col-span-5 flex gap-2 justify-end">
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-2 py-1 rounded bg-ink-800 hover:bg-ink-700"
            >
              Cancel
            </button>
            <button
              onClick={onSaveEdit}
              className="text-xs px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600"
            >
              Save
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="bg-ink-900 border border-zinc-800 rounded-lg p-3 text-sm space-y-1">
          <div>
            <span className="text-zinc-500">Topic:</span> {meta.topic as string ?? "—"}
          </div>
          <div>
            <span className="text-zinc-500">Pillar:</span> {meta.pillar as string ?? "—"}
          </div>
          <div>
            <span className="text-zinc-500">Profile:</span> {meta.videoProfile as string ?? "—"}
          </div>
          <div>
            <span className="text-zinc-500">Source:</span> {meta.runSource as string ?? "backlog"}
          </div>
          <div>
            <span className="text-zinc-500">Project ID:</span>{" "}
            {meta.projectId as string ?? "—"}
          </div>
          <div>
            <span className="text-zinc-500">Publish at:</span>{" "}
            {meta.youtubePublishAt as string ?? "—"}
          </div>
          <div>
            <span className="text-zinc-500">Created:</span>{" "}
            {meta.createdAt as string ?? "—"}
          </div>
          <div>
            <span className="text-zinc-500">Aborted:</span>{" "}
            {meta.abortedAt as string ?? "—"}
          </div>
        </div>
        <div className="bg-ink-900 border border-zinc-800 rounded-lg p-3 text-sm">
          <div className="text-zinc-500 mb-1">Thread history ({threadHistory.length})</div>
          <div className="mono text-xs space-y-0.5 max-h-32 overflow-auto scroll-thin">
            {threadHistory.length === 0 && <div className="text-zinc-600">none</div>}
            {threadHistory.map((t, i) => (
              <div key={i} className="text-zinc-300">
                {i + 1}. {t}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
          Pipeline progress
        </h2>
        <ProgressBar nodeStates={nodeStates} />
      </div>

      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
          Stage status
        </h2>
        <StageGrid stages={detail.stages} />
      </div>

      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
          Live log
        </h2>
        <LogStream initial={initialLog} streamUrl={streamUrl} />
      </div>
    </div>
  );
}
