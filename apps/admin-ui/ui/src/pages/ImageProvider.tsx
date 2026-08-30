import { useEffect, useState } from "react";
import { api } from "../api";

type MediaItem = { filename: string; mime: string; base64: string };

type Health = "ok" | "down" | "unknown";

export function ImageProvider() {
  const [health, setHealth] = useState<Health>("unknown");
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState<"image" | "video">("image");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    const t = setInterval(() => {
      api.imageProvider.health().then(setHealth);
    }, 5000);
    api.imageProvider.health().then(setHealth);
    return () => clearInterval(t);
  }, []);

  async function onGenerate() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    setMedia([]);
    try {
      const r = await api.imageProvider.generate({ prompt, type });
      const items = (r.media as MediaItem[] | undefined) ?? [];
      setMedia(items);
      setFromCache(Boolean(r.fromCache));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Image Provider</h1>
        <HealthPill status={health} />
      </div>

      <div className="bg-ink-900 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Prompt…"
          className="w-full bg-ink-950 border border-zinc-700 rounded px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-3">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "image" | "video")}
            className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="image">image</option>
            <option value="video">video</option>
          </select>
          <button
            onClick={onGenerate}
            disabled={busy || health === "down"}
            className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm font-medium"
          >
            {busy ? "Generating…" : "Generate"}
          </button>
          {fromCache && <span className="text-xs text-emerald-300">cache hit</span>}
        </div>
        {error && <div className="text-rose-400 text-sm">Error: {error}</div>}
      </div>

      {media.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {media.map((m) => (
            <div key={m.filename} className="bg-ink-900 border border-zinc-800 rounded overflow-hidden">
              {m.mime.startsWith("image/") ? (
                <img
                  src={`data:${m.mime};base64,${m.base64}`}
                  alt={m.filename}
                  className="w-full h-48 object-cover"
                />
              ) : (
                <video
                  src={`data:${m.mime};base64,${m.base64}`}
                  controls
                  className="w-full h-48"
                />
              )}
              <div className="px-2 py-1 text-xs text-zinc-400 mono truncate">{m.filename}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthPill({ status }: { status: Health }) {
  const color =
    status === "ok" ? "bg-emerald-700" : status === "down" ? "bg-rose-700" : "bg-zinc-700";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${color} text-zinc-100`}>
      {status}
    </span>
  );
}
