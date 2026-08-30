import { useEffect, useMemo, useState } from "react";
import { api, type RunSummary, type RunStatus } from "../api";

const STATUS_COLOR: Record<RunStatus, string> = {
  new: "bg-zinc-700 text-zinc-200",
  running: "bg-cyan-700 text-cyan-100 animate-pulse",
  incomplete: "bg-amber-700 text-amber-100",
  failed: "bg-rose-700 text-rose-100",
  published: "bg-emerald-700 text-emerald-100",
  aborted: "bg-zinc-600 text-zinc-300",
};

const STATUSES: RunStatus[] = ["new", "running", "incomplete", "failed", "published", "aborted"];

export function Runs({ onOpen }: { onOpen: (ns: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RunStatus | "all">("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .listRuns()
      .then((r) => alive && setRuns(r))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [refreshTick]);

  useEffect(() => {
    const t = setInterval(() => setRefreshTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (profileFilter !== "all" && (r.videoProfile ?? "short") !== profileFilter) return false;
      if (sourceFilter !== "all" && r.runSource !== sourceFilter) return false;
      if (q) {
        const hay = `${r.ns} ${r.topic ?? ""} ${r.pillar ?? ""} ${r.projectId ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [runs, statusFilter, profileFilter, sourceFilter, search]);

  async function onDelete(ns: string) {
    if (!confirm(`Delete run ${ns}? This removes runs/${ns}/ permanently.`)) return;
    try {
      await api.deleteRun(ns);
      setRefreshTick((n) => n + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="p-6 max-w-7xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Runs ({runs.length})</h1>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="text-sm px-3 py-1.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
        >
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="search"
          placeholder="Search ns, topic, pillar, project id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-64 bg-ink-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as RunStatus | "all")}
          className="bg-ink-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={profileFilter}
          onChange={(e) => setProfileFilter(e.target.value)}
          className="bg-ink-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
        >
          <option value="all">All profiles</option>
          <option value="short">short</option>
          <option value="long">long</option>
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="bg-ink-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
        >
          <option value="all">All sources</option>
          <option value="backlog">backlog</option>
          <option value="seed">seed</option>
        </select>
      </div>

      {error && <div className="text-rose-400 mb-3 text-sm">Error: {error}</div>}

      <div className="bg-ink-900 rounded-lg border border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-zinc-400 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-3 py-2">Namespace</th>
              <th className="text-left px-3 py-2">Topic</th>
              <th className="text-left px-3 py-2">Pillar</th>
              <th className="text-left px-3 py-2">Profile</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Created</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-zinc-500 py-12">
                  No runs match the current filters.
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.ns} className="border-t border-zinc-800 hover:bg-ink-800/50">
                <td className="px-3 py-2 mono text-cyan-300">
                  <button
                    onClick={() => onOpen(r.ns)}
                    className="hover:underline text-left"
                  >
                    {r.ns}
                  </button>
                </td>
                <td className="px-3 py-2 max-w-xs truncate" title={r.topic ?? ""}>
                  {r.topic ?? <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-3 py-2">{r.pillar ?? <span className="text-zinc-600">—</span>}</td>
                <td className="px-3 py-2">{r.videoProfile ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-ink-700 text-zinc-300">
                    {r.runSource}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLOR[r.status]}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-400 text-xs">
                  {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onDelete(r.ns)}
                    className="text-xs text-rose-400 hover:text-rose-300"
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
