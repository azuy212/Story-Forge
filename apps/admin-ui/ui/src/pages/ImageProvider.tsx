import { useEffect, useState } from "react";
import { Image as ImageIcon, Loader2, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { truncate } from "@/lib/utils";

type MediaItem = { filename: string; mime: string; base64: string };
type Health = "ok" | "down" | "unknown";

export function ImageProvider() {
  const [health, setHealth] = useState<Health>("unknown");
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState<"image" | "video">("image");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [preview, setPreview] = useState<MediaItem | null>(null);

  useEffect(() => {
    const tick = () => api.imageProvider.health().then(setHealth);
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);

  async function onGenerate() {
    if (!prompt.trim()) {
      toast.warning("Enter a prompt first");
      return;
    }
    setBusy(true);
    setMedia([]);
    try {
      const r = await api.imageProvider.generate({ prompt, type, count });
      const items = (r.media as MediaItem[] | undefined) ?? [];
      setMedia(items);
      const cached = Boolean(r.fromCache);
      setFromCache(cached);
      toast.success(
        cached ? "Cache hit" : `Generated ${items.length} ${type}${items.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error("Generation failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Image Provider"
        description="Generate scene images or short videos using the configured provider."
        meta={<StatusBadge status={health} />}
      />

      <div className="space-y-6 px-4 pb-10 sm:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Generate</CardTitle>
            </div>
            <CardDescription>
              Results are returned inline as base64. Cache hits are reused from previous generations
              with the same prompt.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Prompt
              </label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="A cinematic wide shot of a lonely robot at sunset…"
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Type
                </label>
                <Select value={type} onValueChange={(v) => setType(v as "image" | "video")}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="image">image</SelectItem>
                    <SelectItem value="video">video</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Count
                </label>
                <Select value={String(count)} onValueChange={(v) => setCount(Number(v))}>
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={onGenerate} disabled={busy || health === "down"} className="ml-auto">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy ? "Generating…" : "Generate"}
              </Button>
            </div>
            {fromCache && <Badge variant="success">Cache hit</Badge>}
          </CardContent>
        </Card>

        {media.length === 0 && !busy && (
          <EmptyState
            icon={<ImageIcon className="h-6 w-6" />}
            title="No outputs yet"
            description="Generated media will appear here. The provider may take 5-30 seconds per item."
          />
        )}

        {media.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Output</CardTitle>
                <Badge variant="muted">{media.length}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {media.map((m) => (
                  <button
                    key={m.filename}
                    type="button"
                    onClick={() => setPreview(m)}
                    className="group relative overflow-hidden rounded-md border border-border/60 bg-card/40 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {m.mime.startsWith("image/") ? (
                      <img
                        src={`data:${m.mime};base64,${m.base64}`}
                        alt={m.filename}
                        className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.02]"
                      />
                    ) : (
                      <video
                        src={`data:${m.mime};base64,${m.base64}`}
                        className="aspect-video w-full bg-black"
                        muted
                      />
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-left">
                      <div className="truncate font-mono text-[10px] text-white">
                        {truncate(m.filename, 40)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-4xl">
          {preview &&
            (preview.mime.startsWith("image/") ? (
              <img
                src={`data:${preview.mime};base64,${preview.base64}`}
                alt={preview.filename}
                className="max-h-[80vh] w-full rounded-md bg-black object-contain"
              />
            ) : (
              <video
                src={`data:${preview.mime};base64,${preview.base64}`}
                controls
                className="max-h-[80vh] w-full rounded-md bg-black"
              />
            ))}
        </DialogContent>
      </Dialog>
    </div>
  );
}
