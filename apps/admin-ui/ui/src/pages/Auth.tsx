import { useState } from "react";
import { api } from "../api";

export function Auth() {
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const r = await api.oauthStart();
      setAuthUrl(r.authUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.oauthSave(token);
      setSaved(`Saved to .env (backup: ${r.backup})`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">YouTube OAuth</h1>
      <div className="bg-ink-900 border border-zinc-800 rounded-lg p-4 space-y-4 text-sm">
        <p className="text-zinc-400">
          One-time setup. Spawns the OAuth helper which prints an auth URL. After authorizing in
          the browser, the refresh token is captured. Paste it below to save into{" "}
          <span className="mono text-cyan-300">apps/orchestrator/.env</span>.
        </p>
        <button
          onClick={start}
          disabled={busy}
          className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50"
        >
          {busy ? "Starting…" : "Start OAuth flow"}
        </button>
        {authUrl && (
          <div className="space-y-2">
            <div className="text-zinc-400">Authorize at:</div>
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="block break-all text-cyan-400 underline text-xs"
            >
              {authUrl}
            </a>
            <p className="text-zinc-400 text-xs">
              Open the link, complete consent, then capture the refresh token printed in the
              server terminal. (This UI doesn't capture it automatically — paste it below.)
            </p>
          </div>
        )}
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">Refresh token</label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="1//0e…"
            className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 mono text-xs"
          />
          <button
            onClick={save}
            disabled={busy || !token}
            className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-sm"
          >
            Save to .env
          </button>
        </div>
        {error && <div className="text-rose-400 text-sm">Error: {error}</div>}
        {saved && <div className="text-emerald-300 text-sm">{saved}</div>}
      </div>
    </div>
  );
}
