import { useState } from "react";
import { api } from "../api";

type Tab = "next" | "seed";

export function Launch({ onLaunched }: { onLaunched: (ns: string) => void }) {
  const [tab, setTab] = useState<Tab>("next");
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Launch</h1>
      <div className="flex gap-1 mb-4 bg-ink-900 rounded p-1 border border-zinc-800 inline-flex">
        <button
          onClick={() => setTab("next")}
          className={`px-3 py-1.5 rounded text-sm ${
            tab === "next" ? "bg-ink-800 text-cyan-300" : "text-zinc-400"
          }`}
        >
          Run Next (backlog)
        </button>
        <button
          onClick={() => setTab("seed")}
          className={`px-3 py-1.5 rounded text-sm ${
            tab === "seed" ? "bg-ink-800 text-cyan-300" : "text-zinc-400"
          }`}
        >
          Seed Run
        </button>
      </div>
      {tab === "next" ? <RunNextForm onLaunched={onLaunched} /> : <SeedForm onLaunched={onLaunched} />}
    </div>
  );
}

function RunNextForm({ onLaunched }: { onLaunched: (ns: string) => void }) {
  const [profile, setProfile] = useState<"short" | "long">("short");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api.launchRunNext(profile);
      if (r.none) {
        setInfo(
          r.reason === "no-pending-row"
            ? "No pending planned rows in the backlog."
            : "No free publish slot within 30 days.",
        );
        return;
      }
      onLaunched(r.ns);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-ink-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      <p className="text-sm text-zinc-400">
        Reads the Google Sheets backlog, picks the first pending planned row, and runs it. If a
        run already exists for that topic, resumes it.
      </p>
      <div className="flex items-center gap-3">
        <label className="text-sm text-zinc-400">Profile</label>
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value as "short" | "long")}
          className="bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
        >
          <option value="short">short</option>
          <option value="long">long</option>
        </select>
      </div>
      {error && <div className="text-rose-400 text-sm">Error: {error}</div>}
      {info && <div className="text-amber-300 text-sm">{info}</div>}
      <button
        onClick={onSubmit}
        disabled={busy}
        className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm font-medium"
      >
        {busy ? "Launching…" : "Launch next"}
      </button>
    </div>
  );
}

function SeedForm({ onLaunched }: { onLaunched: (ns: string) => void }) {
  const [seedPath, setSeedPath] = useState("");
  const [pillar, setPillar] = useState("");
  const [topic, setTopic] = useState("");
  const [profile, setProfile] = useState<"short" | "long">("short");
  const [publishAt, setPublishAt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [convertMode, setConvertMode] = useState<"auto" | "convert" | "bypass">("auto");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit() {
    if (!seedPath) {
      setError("Seed path is required");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const body: Record<string, unknown> = { seedPath, profile, dryRun };
      if (pillar) body.pillar = pillar;
      if (topic) body.topic = topic;
      if (publishAt) body.publishAt = new Date(publishAt).toISOString();
      if (projectId) body.projectId = projectId;
      if (convertMode !== "auto") body.convert = convertMode === "convert";
      const r = await api.launchSeed(body);
      setInfo(`Seeded ${r.ns}`);
      onLaunched(r.ns);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-ink-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <p className="text-sm text-zinc-400">
        Feeds pre-written research (and optional script) into the pipeline. Skips the LLM research
        and script producers.
      </p>
      <Field label="Seed file path (.json, .txt, .md)" required>
        <input
          value={seedPath}
          onChange={(e) => setSeedPath(e.target.value)}
          placeholder="/absolute/path/to/seed.json"
          className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm mono"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Pillar (optional)">
          <input
            value={pillar}
            onChange={(e) => setPillar(e.target.value)}
            placeholder="Psychology"
            className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Topic (optional)">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Why your brain…"
            className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Profile">
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value as "short" | "long")}
            className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="short">short</option>
            <option value="long">long</option>
          </select>
        </Field>
        <Field label="Publish at (ISO 8601, optional)">
          <input
            type="datetime-local"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
            className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
        </Field>
      </div>
      <Field label="Sheet row id (project-id, optional)">
        <input
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mode">
          <select
            value={convertMode}
            onChange={(e) => setConvertMode(e.target.value as "auto" | "convert" | "bypass")}
            className="w-full bg-ink-950 border border-zinc-700 rounded px-2 py-1 text-sm"
          >
            <option value="auto">auto-detect</option>
            <option value="convert">force LLM convert</option>
            <option value="bypass">force structured bypass</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-zinc-300 mt-6">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          dry-run (validate only)
        </label>
      </div>
      {error && <div className="text-rose-400 text-sm">Error: {error}</div>}
      {info && <div className="text-emerald-300 text-sm">{info}</div>}
      <button
        onClick={onSubmit}
        disabled={busy}
        className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm font-medium"
      >
        {busy ? "Launching…" : "Launch seed run"}
      </button>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-400 mb-1 block">
        {label}
        {required && <span className="text-rose-400"> *</span>}
      </span>
      {children}
    </label>
  );
}
