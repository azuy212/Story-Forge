import { useEffect, useState } from "react";

type Health = "ok" | "down" | "unknown";

type Word = {
  word: string;
  start: number;
  end: number;
  score?: number;
};

type AlignResult = {
  words: Word[];
  duration?: number;
};

export function Transcriber() {
  const [health, setHealth] = useState<Health>("unknown");
  const [file, setFile] = useState<File | null>(null);
  const [knownText, setKnownText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AlignResult | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch("/api/transcriber/health");
        if (r.ok) {
          setHealth("ok");
        } else {
          setHealth("down");
        }
      } catch {
        setHealth("down");
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);

  async function onAlign() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("audio", file);
      if (knownText.trim()) fd.append("text", knownText);
      const r = await fetch("/api/transcriber/align", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setResult((await r.json()) as AlignResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Transcriber</h1>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            health === "ok" ? "bg-emerald-700" : health === "down" ? "bg-rose-700" : "bg-zinc-700"
          }`}
        >
          {health}
        </span>
      </div>

      <div className="bg-ink-900 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
        <label className="block">
          <span className="text-xs text-zinc-400 mb-1 block">Audio file (WAV preferred)</span>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-zinc-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-ink-800 file:text-zinc-300 hover:file:bg-ink-700"
          />
        </label>
        <label className="block">
          <span className="text-xs text-zinc-400 mb-1 block">
            Known transcript (optional, enables forced alignment)
          </span>
          <textarea
            value={knownText}
            onChange={(e) => setKnownText(e.target.value)}
            rows={2}
            placeholder="Leave empty for full ASR…"
            className="w-full bg-ink-950 border border-zinc-700 rounded px-3 py-2 text-sm"
          />
        </label>
        <button
          onClick={onAlign}
          disabled={busy || !file || health === "down"}
          className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm font-medium"
        >
          {busy ? "Aligning…" : "Align"}
        </button>
        {error && <div className="text-rose-400 text-sm">Error: {error}</div>}
      </div>

      {result && (
        <div className="bg-ink-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-zinc-800 text-sm text-zinc-400 flex items-center justify-between">
            <span>{result.words.length} words</span>
            {result.duration && <span>{result.duration.toFixed(2)}s</span>}
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-sm">
              <thead className="bg-ink-800 text-xs text-zinc-400 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Word</th>
                  <th className="text-right px-3 py-2">Start (s)</th>
                  <th className="text-right px-3 py-2">End (s)</th>
                  <th className="text-right px-3 py-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {result.words.map((w, i) => (
                  <tr key={i} className="border-t border-zinc-800">
                    <td className="px-3 py-1.5">{w.word}</td>
                    <td className="px-3 py-1.5 text-right mono text-zinc-300">
                      {w.start.toFixed(3)}
                    </td>
                    <td className="px-3 py-1.5 text-right mono text-zinc-300">
                      {w.end.toFixed(3)}
                    </td>
                    <td className="px-3 py-1.5 text-right mono text-zinc-400">
                      {w.score?.toFixed(3) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
