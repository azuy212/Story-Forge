import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Pause,
  Play,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import type { LogEvent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  node_start: Loader2,
  node_end: CheckCircle2,
  node_failed: AlertCircle,
  llm_call: Sparkles,
  stderr: AlertTriangle,
  raw: TerminalSquare,
  error: AlertCircle,
  log: TerminalSquare,
};

const TONE: Record<string, string> = {
  node_start: "text-primary",
  node_end: "text-success",
  node_failed: "text-destructive",
  llm_call: "text-chart-4",
  stderr: "text-warning",
  raw: "text-muted-foreground",
  error: "text-destructive",
  log: "text-foreground/80",
};

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtEvent(event: LogEvent): React.ReactNode {
  const ev = String(event.event ?? "log");
  const node = (event as Record<string, unknown>).node as string | undefined;
  const dur = (event as Record<string, unknown>).durationMs as number | undefined;
  const model = (event as Record<string, unknown>).model as string | undefined;
  const usage = (event as Record<string, unknown>).usage as
    | { totalTokens?: number }
    | undefined;
  const err = (event as Record<string, unknown>).error as string | undefined;
  const data = (event as Record<string, unknown>).data as string | undefined;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-semibold text-foreground/90">{ev}</span>
      {node && <span className="text-primary">{node}</span>}
      {typeof dur === "number" && (
        <span className="text-muted-foreground">· {dur}ms</span>
      )}
      {model && <span className="text-muted-foreground">· {String(model)}</span>}
      {usage?.totalTokens != null && (
        <span className="text-muted-foreground">· {usage.totalTokens} tok</span>
      )}
      {err && <span className="text-destructive">· {String(err).slice(0, 200)}</span>}
      {data && <span className="text-muted-foreground">· {String(data).slice(0, 200)}</span>}
    </span>
  );
}

export function LogStream({
  initial,
  streamUrl,
}: {
  initial: LogEvent[];
  streamUrl: string | null;
}) {
  const [events, setEvents] = useState<LogEvent[]>(initial);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const eventsRef = useRef<LogEvent[]>(initial);
  eventsRef.current = events;

  useEffect(() => {
    if (!streamUrl || paused) return;
    const es = new EventSource(streamUrl);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const onMsg = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as LogEvent;
        if (data.event === "log" || data.event === "stderr" || data.event === "error") {
          setEvents((prev) => {
            const next = [...prev, data];
            return next.length > 2000 ? next.slice(-2000) : next;
          });
        }
      } catch {
        // ignore
      }
    };
    es.addEventListener("log", onMsg);
    es.addEventListener("stderr", onMsg);
    es.addEventListener("error", onMsg);
    return () => {
      es.close();
    };
  }, [streamUrl, paused]);

  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, paused]);

  const counts = useMemo(() => {
    let info = 0,
      warn = 0,
      err = 0;
    for (const e of events) {
      if (e.event === "error" || e.event === "node_failed") err++;
      else if (e.event === "stderr") warn++;
      else info++;
    }
    return { info, warn, err };
  }, [events]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-card/60 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-semibold text-foreground">Live log</span>
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              connected ? "bg-success animate-pulse" : "bg-muted-foreground/40",
            )}
            title={connected ? "Connected" : "Disconnected"}
          />
          <span className="text-muted-foreground">
            {events.length} {events.length === 1 ? "event" : "events"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {counts.err > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
              {counts.err} error{counts.err === 1 ? "" : "s"}
            </Badge>
          )}
          {counts.warn > 0 && (
            <Badge variant="warning" className="h-5 px-1.5 text-[10px]">
              {counts.warn} warn
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            className="h-7 px-2 text-xs"
          >
            {paused ? (
              <>
                <Play className="h-3 w-3" /> Resume
              </>
            ) : (
              <>
                <Pause className="h-3 w-3" /> Pause
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEvents([])}
            className="h-7 px-2 text-xs"
            disabled={events.length === 0}
          >
            <Trash2 className="h-3 w-3" /> Clear
          </Button>
        </div>
      </div>
      <ScrollArea className="h-96">
        <div
          ref={scrollRef}
          className="min-h-full space-y-0.5 px-3 py-2 font-mono text-xs leading-relaxed"
        >
          {events.length === 0 ? (
            <div className="flex h-96 flex-col items-center justify-center gap-1 text-muted-foreground">
              <CircleDashed className="h-5 w-5 opacity-60" />
              <span>No log events yet</span>
              <span className="text-[10px] text-muted-foreground/70">
                Connect a stream to begin
              </span>
            </div>
          ) : (
            events.map((e, i) => {
              const ev = String(e.event ?? "log");
              const Icon = ICON[ev] ?? TerminalSquare;
              return (
                <div
                  key={i}
                  className="grid grid-cols-[88px_16px_1fr] items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/30"
                >
                  <span className="select-none text-muted-foreground/70">
                    {fmtTime(e.ts)}
                  </span>
                  <Icon className={cn("h-3 w-3 shrink-0", TONE[ev] ?? "text-muted-foreground")} />
                  <span className="break-words">{fmtEvent(e)}</span>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
