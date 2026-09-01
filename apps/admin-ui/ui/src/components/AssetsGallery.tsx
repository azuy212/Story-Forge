import { useEffect, useMemo, useState } from "react";
import {
  Download,
  Image as ImageIcon,
  Mic2,
  Captions,
  Video,
  Tag,
  ChevronDown,
  Maximize2,
  X,
  FileText,
} from "lucide-react";
import type { AssetsPayload } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { CopyButton, MetaRow } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDuration, truncate } from "@/lib/utils";

type Props = { assets: AssetsPayload | null };

function srtBlobUrl(srt: string): string {
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  return URL.createObjectURL(blob);
}

export function AssetsGallery({ assets }: Props) {
  const [modalScene, setModalScene] = useState<number | null>(null);
  const [srtUrl, setSrtUrl] = useState<string | null>(null);
  const [showMetadata, setShowMetadata] = useState(true);

  useEffect(() => {
    if (assets?.subtitles?.srt) {
      const url = srtBlobUrl(assets.subtitles.srt);
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

  const openScene = modalScene == null ? null : assets?.scenes.find((s) => s.sceneId === modalScene) ?? null;

  if (!assets || isEmpty) {
    return (
      <EmptyState
        icon={<ImageIcon className="h-6 w-6" />}
        title="No assets yet"
        description="Pipeline hasn't reached AssetGenerator. Generated scenes, audio, subtitles, and metadata will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <FinalCard
          title="Video"
          icon={<Video className="h-4 w-4" />}
          subtitle={assets.video ? formatDuration(assets.video.durationMs) : null}
        >
          {assets.video?.url ? (
            <video
              controls
              className="w-full rounded-md bg-black"
              src={assets.video.url}
              style={{ maxHeight: 360 }}
            />
          ) : (
            <Placeholder text="Not composed yet" icon={<Video className="h-5 w-5" />} />
          )}
        </FinalCard>

        <FinalCard
          title="Thumbnail"
          icon={<ImageIcon className="h-4 w-4" />}
          subtitle={assets.thumbnail ? `${assets.thumbnail.width}×${assets.thumbnail.height}` : null}
        >
          {assets.thumbnail?.url ? (
            <button
              type="button"
              onClick={() => {
                if (assets.thumbnail?.url) {
                  setModalScene(-1);
                }
              }}
              className="group relative w-full overflow-hidden rounded-md bg-black"
            >
              <img
                src={assets.thumbnail.url}
                alt={assets.thumbnail.text}
                className="w-full object-contain transition-transform group-hover:scale-[1.02]"
                style={{ maxHeight: 360 }}
              />
              <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ) : (
            <Placeholder text="No thumbnail" icon={<ImageIcon className="h-5 w-5" />} />
          )}
        </FinalCard>

        <FinalCard
          title="Subtitles"
          icon={<Captions className="h-4 w-4" />}
          subtitle={
            assets.subtitles
              ? `${assets.subtitles.cueCount ?? "?"} cues · ${assets.subtitles.format ?? "?"}`
              : null
          }
        >
          {assets.subtitles?.srt ? (
            <div className="space-y-2">
              <ScrollArea className="h-80 rounded-md border border-border/60 bg-background/40">
                <pre className="whitespace-pre-wrap wrap-break-word p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
                  {assets.subtitles.srt}
                </pre>
              </ScrollArea>
              {srtUrl && (
                <a
                  href={srtUrl}
                  download={`subtitles.${assets.subtitles.format ?? "srt"}`}
                  className="inline-flex"
                >
                  <Button variant="outline" size="sm" className="h-7 text-xs">
                    <Download className="h-3 w-3" /> Download
                  </Button>
                </a>
              )}
            </div>
          ) : (
            <Placeholder text="No subtitles" icon={<Captions className="h-5 w-5" />} />
          )}
        </FinalCard>
      </div>

      {assets.audio && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Mic2 className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Audio</CardTitle>
              <Badge variant="muted">{assets.audio.scenes.length} scenes</Badge>
              {assets.audio.voice && (
                <Badge variant="outline" className="font-mono text-[10px]">
                  {assets.audio.voice}
                </Badge>
              )}
            </div>
            {assets.audio.combinedUrl && (
              <div className="flex items-center gap-3 text-xs">
                <span className="font-mono text-muted-foreground">
                  {formatDuration(assets.audio.combinedDurationMs)}
                </span>
                <audio controls src={assets.audio.combinedUrl} className="h-7" />
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {assets.audio.scenes.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                  No scene audio.
                </div>
              ) : (
                assets.audio.scenes.map((a) => (
                  <div
                    key={a.sceneId}
                    className="flex items-center gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2"
                  >
                    <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                      #{a.sceneId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm" title={a.narration}>
                      {a.narration}
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {formatDuration(a.durationMs)}
                    </span>
                    {a.url ? (
                      <audio controls src={a.url} className="h-7 shrink-0" />
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">
                        missing
                      </Badge>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Scene images</CardTitle>
            <Badge variant="muted">{assets.scenes.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {assets.scenes.length === 0 ? (
            <Placeholder text="No scene images" icon={<ImageIcon className="h-5 w-5" />} />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {assets.scenes.map((s) => (
                <button
                  key={s.sceneId}
                  type="button"
                  onClick={() => s.assetUrl && setModalScene(s.sceneId)}
                  disabled={!s.assetUrl}
                  className="group relative aspect-9/16 overflow-hidden rounded-md border border-border/60 bg-background/40 transition-colors hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  title={s.narration ?? `Scene ${s.sceneId}`}
                >
                  {s.assetUrl ? (
                    <img
                      src={s.assetUrl}
                      alt={`scene ${s.sceneId}`}
                      className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                      no image
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="flex items-center justify-between text-[10px] text-white">
                      <span className="font-mono">#{s.sceneId}</span>
                      {s.provider && <span className="font-mono opacity-80">{s.provider}</span>}
                    </div>
                  </div>
                  <div className="absolute left-1.5 top-1.5">
                    <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
                      #{s.sceneId}
                    </span>
                  </div>
                  {s.provider && (
                    <div className="absolute right-1.5 top-1.5">
                      <span className="rounded bg-primary/80 px-1.5 py-0.5 font-mono text-[10px] text-primary-foreground">
                        {s.provider}
                      </span>
                    </div>
                  )}
                  {s.generationStatus && s.generationStatus !== "complete" && (
                    <div className="absolute inset-x-1.5 bottom-1.5">
                      <span className="block rounded bg-warning/90 px-1.5 py-0.5 text-center text-[10px] text-warning-foreground">
                        {s.generationStatus}
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {assets.metadata && (
        <Card>
          <button
            type="button"
            onClick={() => setShowMetadata((s) => !s)}
            className="flex w-full items-center justify-between px-5 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Metadata</CardTitle>
            </div>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${showMetadata ? "rotate-180" : ""}`}
            />
          </button>
          {showMetadata && (
            <>
              <Separator />
              <CardContent className="space-y-1">
                <MetaRow label="Title" value={assets.metadata.title} copyable />
                <MetaRow
                  label="Description"
                  value={truncate(assets.metadata.description ?? "", 240)}
                  copyable
                />
                <div className="flex flex-col gap-1 py-1.5">
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">Tags</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {assets.metadata.tags && assets.metadata.tags.length > 0 ? (
                      <>
                        {assets.metadata.tags.map((t, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                          >
                            <Tag className="h-2.5 w-2.5 text-muted-foreground" /> {t}
                          </span>
                        ))}
                        {assets.metadata.title && <CopyButton value={assets.metadata.tags.join(", ")} />}
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground/60">—</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      )}

      <Dialog open={modalScene !== null} onOpenChange={(o) => !o && setModalScene(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {modalScene === -1 ? (
                <>Thumbnail</>
              ) : (
                <>
                  <span className="font-mono text-primary">Scene #{openScene?.sceneId}</span>
                  {openScene?.provider && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {openScene.provider}
                    </Badge>
                  )}
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {modalScene === -1 && assets.thumbnail?.url ? (
            <img
              src={assets.thumbnail.url}
              alt={assets.thumbnail.text}
              className="max-h-[60vh] w-full rounded-md bg-black object-contain"
            />
          ) : (
            openScene?.assetUrl && (
              <>
                <img
                  src={openScene.assetUrl}
                  alt={`scene ${openScene.sceneId}`}
                  className="max-h-[60vh] w-full rounded-md bg-black object-contain"
                />
                {openScene.narration && (
                  <p className="text-sm leading-relaxed text-foreground/90">{openScene.narration}</p>
                )}
              </>
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FinalCard({
  title,
  icon,
  subtitle,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  subtitle?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle>{title}</CardTitle>
        </div>
        {subtitle && <span className="font-mono text-[10px] text-muted-foreground">{subtitle}</span>}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

function Placeholder({
  text,
  icon,
}: {
  text: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/60 bg-background/30 text-xs text-muted-foreground">
      {icon && <span className="opacity-60">{icon}</span>}
      <span>{text}</span>
    </div>
  );
}
