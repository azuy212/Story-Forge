import { useEffect, useState } from "react";
import { api, type RunSummary } from "../api";

type ServiceHealth = { name: string; status: "ok" | "down" | "unknown" };

async function ping(url: string): Promise<"ok" | "down"> {
  try {
    const r = await fetch(url);
    return r.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

export function Home() {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    const tick = async () => {
      const orch = (await api.health().then((h) => h.langgraph).catch(() => "down")) as
        | "ok"
        | "down";
      const [img, tts, txr] = await Promise.all([
        api.imageProvider.health(),
        api.tts.health(),
        api.transcriber.health(),
      ]);
      setServices([
        { name: "Orchestrator (langgraph)", status: orch },
        { name: "Image Provider", status: img },
        { name: "TTS", status: tts },
        { name: "Transcriber", status: txr },
      ]);
    };
    const loadRuns = async () => {
      try {
        const r = await api.listRuns();
        setRecentRuns(r.slice(0, 5));
      } catch {
        // ignore
      }
    };
    tick();
    loadRuns();
    const t = setInterval(() => {
      tick();
      loadRuns();
    }, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold mb-4">Services</h1>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {services.map((s) => (
            <div
              key={s.name}
              className="bg-ink-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between"
            >
              <span className="text-sm">{s.name}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  s.status === "ok"
                    ? "bg-emerald-700"
                    : s.status === "down"
                      ? "bg-rose-700"
                      : "bg-zinc-700"
                }`}
              >
                {s.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Recent runs</h2>
        <div className="bg-ink-900 border border-zinc-800 rounded-lg overflow-hidden">
          {recentRuns.length === 0 ? (
            <div className="p-6 text-zinc-500 text-sm text-center">No runs yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-ink-800 text-xs text-zinc-400 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Namespace</th>
                  <th className="text-left px-3 py-2">Topic</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((r) => (
                  <tr key={r.ns} className="border-t border-zinc-800">
                    <td className="px-3 py-2 mono text-cyan-300">
                      <a href={`#/run/${r.ns}`} className="hover:underline">
                        {r.ns}
                      </a>
                    </td>
                    <td className="px-3 py-2 max-w-md truncate">{r.topic ?? "—"}</td>
                    <td className="px-3 py-2">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <a
            href="#/launch"
            className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 text-sm font-medium"
          >
            Run Next (backlog)
          </a>
          <a
            href="#/launch"
            className="px-4 py-2 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700 text-sm"
          >
            Seed Run
          </a>
          <a
            href="#/runs"
            className="px-4 py-2 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700 text-sm"
          >
            Browse all runs
          </a>
          <a
            href="#/image"
            className="px-4 py-2 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700 text-sm"
          >
            Image Provider
          </a>
          <a
            href="#/auth"
            className="px-4 py-2 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700 text-sm"
          >
            YouTube Auth
          </a>
        </div>
      </div>
    </div>
  );
}
