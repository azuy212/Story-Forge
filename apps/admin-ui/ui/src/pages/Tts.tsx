import { useEffect, useState } from "react";
import { Download, Loader2, Mic2, MicOff, Play, Sparkles } from "lucide-react";
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
import { toast } from "@/components/ui/toast";
import { truncate } from "@/lib/utils";
import { useConfig } from "@/lib/config-context";

type Voice = { name: string; size: number };
type Health = "ok" | "down" | "unknown";
type HistoryItem = { url: string; text: string; voice: string };

export function Tts() {
  const { ttsEnabled } = useConfig();
  const [health, setHealth] = useState<Health>("unknown");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    if (!ttsEnabled) return;
    const tick = async () => {
      try {
        const r = await fetch("/api/tts/");
        setHealth(r.ok ? "ok" : "down");
      } catch {
        setHealth("down");
      }
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
  }, [voice, ttsEnabled]);

  if (!ttsEnabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Text to Speech" description="Synthesize narration with the configured TTS provider." />
        <div className="space-y-6 px-4 pb-10 sm:px-6">
          <EmptyState
            icon={<MicOff className="h-6 w-6" />}
            title="TTS service not configured"
            description="The TTS provider is not ChatterBox, so the local TTS service is disabled. Narration is synthesized through the configured remote provider instead."
          />
        </div>
      </div>
    );
  }

  async function onGenerate() {
    if (!text.trim()) {
      toast.warning("Enter some text first");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/tts/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: voice || undefined }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = (await r.json()) as { url: string };
      setHistory((h) => [{ url: d.url, text, voice }, ...h].slice(0, 20));
      toast.success("Audio generated");
    } catch (e) {
      toast.error("Generation failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Text to Speech"
        description="Synthesize narration with the configured TTS provider."
        meta={<StatusBadge status={health} />}
      />

      <div className="space-y-6 px-4 pb-10 sm:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mic2 className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Synthesize</CardTitle>
            </div>
            <CardDescription>
              Voice list is loaded from <span className="font-mono text-foreground/80">apps/tts/app/voices/</span>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Text
              </label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="Paste narration here…"
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-56 space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Voice
                </label>
                <Select value={voice || "default"} onValueChange={setVoice}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">(default)</SelectItem>
                    {voices.map((v) => (
                      <SelectItem key={v.name} value={v.name.replace(/\.[^.]+$/, "")}>
                        {v.name}
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
          </CardContent>
        </Card>

        {history.length === 0 && !busy && (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title="No history yet"
            description="Generated audio appears here. Last 20 entries are kept."
          />
        )}

        {history.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Play className="h-4 w-4 text-muted-foreground" />
                <CardTitle>History</CardTitle>
                <Badge variant="muted">{history.length}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {history.map((h, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/40 p-3 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm">{h.text}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{h.voice || "default"}</span>
                    </div>
                  </div>
                  <audio src={h.url} controls className="h-9 w-full sm:w-64" />
                  <a
                    href={h.url}
                    download
                    className="inline-flex shrink-0"
                    title={truncate(h.url, 60)}
                  >
                    <Button variant="outline" size="sm">
                      <Download className="h-3 w-3" /> Download
                    </Button>
                  </a>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
