import { useMemo, useState, useEffect } from "react";
import type { AssetsPayload } from "../api";

type Props = { assets: AssetsPayload | null };

function fmtMs(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function SrtBlobUrl(srt: string): string {
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  return URL.createObjectURL(blob);
}

export function AssetsGallery({ assets }: Props) {
  const [modalScene, setModalScene] = useState<number | null>(null);
  const [srtUrl, setSrtUrl] = useState<string | null>(null);

  useEffect(() => {
    if (assets?.subtitles?.srt) {
      const url = SrtBlobUrl(assets.subtitles.srt);
      setSrtUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setSrtUrl(null);
    return undefined;
  }, [assets?.subtitles?.srt]);

  const isEmpty = useMemo(
    () =>
      !assets ||
      (assets.scenes.length === 0 &&
        !assets.thumbnail &&
        !assets.audio &&
        !assets.subtitles &&
        !assets.video &&
        !assets.metadata),
    [assets],
  );

  if (!assets || isEmpty) {
    return (
      <div className="text-xs text-zinc-500 italic">
        No generated assets yet — pipeline hasn't reached AssetGenerator.
      </div>
    );
  }

  const sceneById = (id: number | null) =>
    id == null ? null : assets.scenes.find((s) => s.sceneId === id) ?? null;
  const openScene = modalScene == null ? null : sceneById(modalScene);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <FinalCard title="Video" subtitle={assets.video ? fmtMs(assets.video.durationMs) : null}>
          {assets.video?.url ? (
            <video
              controls
              className="w-full rounded bg-black"
              src={assets.video.url}
              style={{ maxHeight: 360 }}
            />
          ) : (
            <Placeholder text="Not composed yet" />
          )}
        </FinalCard>

        <FinalCard
          title="Thumbnail"
          subtitle={assets.thumbnail ? `${assets.thumbnail.width}×${assets.thumbnail.height}` : null}
        >
          {assets.thumbnail?.url ? (
            <img
              src={assets.thumbnail.url}
              alt={assets.thumbnail.text}
              className="w-full rounded bg-black object-contain"
              style={{ maxHeight: 360 }}
            />
          ) : (
            <Placeholder text="No thumbnail" />
          )}
        </FinalCard>

        <FinalCard
          title="Subtitles"
          subtitle={
            assets.subtitles
              ? `${assets.subtitles.cueCount ?? "?"} cues · ${assets.subtitles.format ?? "?"}`
              : null
          }
        >
          {assets.subtitles?.srt ? (
            <div className="space-y-2">
              <pre className="mono text-[10px] bg-ink-950 border border-zinc-800 rounded p-2 max-h-80 overflow-auto scroll-thin whitespace-pre-wrap break-words">
                {assets.subtitles.srt}
              </pre>
              {srtUrl && (
                <a
                  href={srtUrl}
                  download={`subtitles.${assets.subtitles.format ?? "srt"}`}
                  className="text-xs px-2 py-1 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700 inline-block"
                >
                  Download .{assets.subtitles.format ?? "srt"}
                </a>
              )}
            </div>
          ) : (
            <Placeholder text="No subtitles" />
          )}
        </FinalCard>
      </div>

      {assets.audio && (
        <div className="bg-ink-900 border border-zinc-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Audio ({assets.audio.scenes.length} scenes)
            </h3>
            {assets.audio.combinedUrl && (
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="mono">{fmtMs(assets.audio.combinedDurationMs)}</span>
                <audio controls src={assets.audio.combinedUrl} className="h-7" />
              </div>
            )}
          </div>
          <div className="space-y-1.5 max-h-72 overflow-auto scroll-thin">
            {assets.audio.scenes.map((a) => (
              <div
                key={a.sceneId}
                className="flex items-center gap-2 text-xs bg-ink-950 border border-zinc-800 rounded px-2 py-1.5"
              >
                <span className="text-zinc-500 mono w-10 shrink-0">#{a.sceneId}</span>
                <span className="flex-1 text-zinc-300 truncate" title={a.narration}>
                  {a.narration}
                </span>
                <span className="text-zinc-500 mono shrink-0">{fmtMs(a.durationMs)}</span>
                {a.url ? (
                  <audio controls src={a.url} className="h-7 shrink-0" />
                ) : (
                  <span className="text-rose-400 mono">missing</span>
                )}
              </div>
            ))}
            {assets.audio.scenes.length === 0 && (
              <div className="text-zinc-500 italic text-xs">No scene audio.</div>
            )}
          </div>
        </div>
      )}

      <div className="bg-ink-900 border border-zinc-800 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
          Scene images ({assets.scenes.length})
        </h3>
        {assets.scenes.length === 0 ? (
          <Placeholder text="No scene images" />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {assets.scenes.map((s) => (
              <button
                key={s.sceneId}
                onClick={() => s.assetUrl && setModalScene(s.sceneId)}
                disabled={!s.assetUrl}
                className="group relative aspect-[9/16] bg-ink-950 border border-zinc-800 rounded overflow-hidden hover:border-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed"
                title={s.narration ?? `Scene ${s.sceneId}`}
              >
                {s.assetUrl ? (
                  <img
                    src={s.assetUrl}
                    alt={`scene ${s.sceneId}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">
                    no image
                  </div>
                )}
                <div className="absolute top-1 left-1 text-[10px] mono bg-black/70 px-1.5 py-0.5 rounded">
                  #{s.sceneId}
                </div>
                {s.provider && (
                  <div className="absolute top-1 right-1 text-[10px] mono bg-black/70 px-1.5 py-0.5 rounded text-cyan-300">
                    {s.provider}
                  </div>
                )}
                {s.generationStatus && s.generationStatus !== "complete" && (
                  <div className="absolute bottom-1 left-1 right-1 text-[10px] mono bg-amber-700/80 px-1.5 py-0.5 rounded text-amber-100 text-center">
                    {s.generationStatus}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {assets.metadata && (
        <details
          open
          className="bg-ink-900 border border-zinc-800 rounded-lg p-3"
        >
          <summary className="text-xs font-semibold text-zinc-400 uppercase tracking-wider cursor-pointer">
            Metadata
          </summary>
          <div className="mt-2 space-y-2 text-sm">
            <MetaRow
              label="Title"
              value={assets.metadata.title}
              onCopy={copyText}
            />
            <MetaRow
              label="Description"
              value={assets.metadata.description}
              multiline
              onCopy={copyText}
            />
            <MetaRow
              label="Tags"
              value={
                assets.metadata.tags && assets.metadata.tags.length > 0
                  ? assets.metadata.tags.join(", ")
                  : null
              }
              onCopy={copyText}
              extra={
                assets.metadata.tags && assets.metadata.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {assets.metadata.tags.map((t, i) => (
                      <span
                        key={i}
                        className="text-[10px] mono bg-ink-800 border border-zinc-700 px-1.5 py-0.5 rounded text-zinc-300"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null
              }
            />
          </div>
        </details>
      )}

      {openScene && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
          onClick={() => setModalScene(null)}
        >
          <div
            className="bg-ink-900 border border-zinc-700 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-auto scroll-thin p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-cyan-300 mono text-sm">
                Scene #{openScene.sceneId}
                {openScene.provider ? ` · ${openScene.provider}` : ""}
              </div>
              <button
                onClick={() => setModalScene(null)}
                className="text-xs px-2 py-1 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700"
              >
                Close
              </button>
            </div>
            {openScene.assetUrl && (
              <img
                src={openScene.assetUrl}
                alt={`scene ${openScene.sceneId}`}
                className="w-full rounded bg-black max-h-[60vh] object-contain"
              />
            )}
            {openScene.narration && (
              <p className="text-sm text-zinc-200 leading-relaxed">{openScene.narration}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function MetaRow({
  label,
  value,
  multiline = false,
  extra = null,
  onCopy,
}: {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
  extra?: React.ReactNode;
  onCopy: (v: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const hasValue = !!value;
  async function handle() {
    if (!value) return;
    const ok = await onCopy(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-zinc-500 shrink-0">{label}:</span>
        <span
          className={`flex-1 text-zinc-200 ${multiline ? "whitespace-pre-wrap" : "truncate"}`}
          title={value ?? undefined}
        >
          {value ?? "—"}
        </span>
        <button
          onClick={handle}
          disabled={!hasValue}
          className="text-[10px] mono px-2 py-0.5 rounded bg-ink-800 hover:bg-ink-700 border border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {extra}
    </div>
  );
}

function FinalCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-ink-900 border border-zinc-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</h3>
        {subtitle && <span className="text-[10px] mono text-zinc-500">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="w-full h-32 flex items-center justify-center text-zinc-600 text-xs italic bg-ink-950 border border-zinc-800 rounded">
      {text}
    </div>
  );
}
