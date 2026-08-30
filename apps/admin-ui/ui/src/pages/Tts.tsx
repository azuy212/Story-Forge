import { useEffect, useState } from "react";

type Voice = { name: string; size: number };
type Health = "ok" | "down" | "unknown";

export function Tts() {
  const [health, setHealth] = useState<Health>("unknown");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ url: string; text: string; voice: string }[]>([]);

  useEffect(() => {
    const tick = async () => {
      setHealth(await healthCheck());
      try {
        const r = await fetch("/api/tts/voices");
        if (r.ok) {
          const d = (await r.json()) as { voices: Voice[] };
          setVoices(d.voices);
          if (!voice && d.voices[0]) setVoice(d.voices[0].name.replace(/\.[^.]+$/, ""));
        }
      } catch {
        // ignore
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [voice]);

  async function healthCheck(): Promise<Health> {
    try {
      const r = await fetch("/api/tts/");
      return r.ok ? "ok" : "down";
    } catch {
      return "down";
    }
  }

  async function onGenerate() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/tts/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: voice || undefined }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = (await r.json()) as { url: string };
      setHistory((h) => [{ url: d.url, text, voice }, ...h].slice(0, 20));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">TTS</h1>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            health === "ok" ? "bg-emerald-700" : health === "down" ? "bg-rose-700" : "bg-zinc-700"
          }`}
        >
          {health}
        </span>
      </div>

      <div className="bg-ink-900 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Text to synthesize…"
          className="w-full bg-ink-950 border border-zinc-700 rounded px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="">(default)</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name.replace(/\.[^.]+$/, "")}>
                {v.name}
              </option>
            ))}
          </select>
          <button
            onClick={onGenerate}
            disabled={busy || health === "down"}
            className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm font-medium"
          >
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
        {error && <div className="text-rose-400 text-sm">Error: {error}</div>}
      </div>

      {history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">History</h2>
          {history.map((h, i) => (
            <div key={i} className="bg-ink-900 border border-zinc-800 rounded p-3 space-y-2">
              <div className="text-xs text-zinc-400 line-clamp-1">
                {h.voice || "default"} — {h.text}
              </div>
              <audio src={h.url} controls className="w-full" />
              <a
                href={h.url}
                download
                className="text-xs text-cyan-400 hover:underline inline-block"
              >
                download
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
