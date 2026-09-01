import { useEffect, useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { FileAudio, Loader2, Upload, Waves } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { toast } from "@/components/ui/toast";
import { formatMs, truncate } from "@/lib/utils";

type Health = "ok" | "down" | "unknown";
type Word = { word: string; start: number; end: number; score?: number };
type AlignResult = { words: Word[]; duration?: number };

export function Transcriber() {
  const [health, setHealth] = useState<Health>("unknown");
  const [file, setFile] = useState<File | null>(null);
  const [knownText, setKnownText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AlignResult | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch("/api/transcriber/health");
        setHealth(r.ok ? "ok" : "down");
      } catch {
        setHealth("down");
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted.length > 0) {
      setFile(accepted[0]);
      setResult(null);
    }
  }, []);
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: { "audio/*": [".wav", ".mp3", ".m4a", ".flac", ".ogg"] },
    multiple: false,
    noClick: true,
    noKeyboard: true,
  });

  async function onAlign() {
    if (!file) {
      toast.warning("Pick or drop an audio file first");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("audio", file);
      if (knownText.trim()) fd.append("text", knownText);
      const r = await fetch("/api/transcriber/align", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setResult((await r.json()) as AlignResult);
      toast.success("Alignment complete");
    } catch (e) {
      toast.error("Alignment failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transcriber"
        description="Force-align audio to text or run full ASR."
        meta={<StatusBadge status={health} />}
      />

      <div className="space-y-6 px-4 pb-10 sm:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Waves className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Align</CardTitle>
            </div>
            <CardDescription>
              Drop a WAV (or similar) below. Provide a known transcript to enable forced alignment;
              otherwise the service runs full ASR.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              {...getRootProps()}
              className={`flex flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-background/30 px-6 py-8 text-center transition-colors ${
                isDragActive ? "border-primary bg-primary/5" : "border-border/60"
              }`}
            >
              <input {...getInputProps()} />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                <Upload className="h-4 w-4" />
              </div>
              {file ? (
                <div className="flex items-center gap-2 text-sm">
                  <FileAudio className="h-4 w-4 text-primary" />
                  <span className="font-medium text-foreground">{file.name}</span>
                  <Badge variant="muted">{(file.size / 1024).toFixed(1)} KB</Badge>
                </div>
              ) : (
                <div className="space-y-1 text-sm">
                  <p className="text-foreground">
                    {isDragActive ? "Drop the audio here" : "Drag & drop an audio file"}
                  </p>
                  <p className="text-xs text-muted-foreground">or</p>
                </div>
              )}
              <Button type="button" variant="outline" size="sm" onClick={open}>
                {file ? "Choose another" : "Choose file"}
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Known transcript (optional — enables forced alignment)
              </label>
              <Textarea
                value={knownText}
                onChange={(e) => setKnownText(e.target.value)}
                rows={2}
                placeholder="Leave empty for full ASR…"
              />
            </div>

            <Button onClick={onAlign} disabled={busy || !file || health === "down"}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Aligning…" : "Align"}
            </Button>
          </CardContent>
        </Card>

        {busy && (
          <Card>
            <CardHeader>
              <CardTitle>Result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </CardContent>
          </Card>
        )}

        {!busy && result === null && (
          <EmptyState
            icon={<Waves className="h-6 w-6" />}
            title="No alignment yet"
            description="Drop an audio file and click Align to see word-level timing."
          />
        )}

        {result && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>Word-level timing</CardTitle>
                <Badge variant="muted">{result.words.length} words</Badge>
                {result.duration && (
                  <Badge variant="outline" className="font-mono">
                    {formatMs(result.duration)}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-md border border-border/60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Word</TableHead>
                      <TableHead className="text-right">Start</TableHead>
                      <TableHead className="text-right">End</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.words.map((w, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{w.word}</TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {w.start.toFixed(3)}s
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {w.end.toFixed(3)}s
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {w.score?.toFixed(3) ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
