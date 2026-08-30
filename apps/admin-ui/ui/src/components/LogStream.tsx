import { useEffect, useRef, useState } from "react";
import type { LogEvent } from "../api";

const COLOR: Record<string, string> = {
  node_start: "text-cyan-300",
  node_end: "text-emerald-300",
  node_failed: "text-rose-300",
  llm_call: "text-violet-300",
  stderr: "text-amber-300",
  raw: "text-zinc-500",
  error: "text-rose-400",
};

function fmt(event: LogEvent): string {
  const ev = event.event ?? "log";
  const node = (event as Record<string, unknown>).node as string | undefined;
  const dur = (event as Record<string, unknown>).durationMs as number | undefined;
  const model = (event as Record<string, unknown>).model as string | undefined;
  const usage = (event as Record<string, unknown>).usage as
    | { totalTokens?: number }
    | undefined;
  const err = (event as Record<string, unknown>).error as string | undefined;
  const data = (event as Record<string, unknown>).data as string | undefined;
  const ts = event.ts ? new Date(event.ts).toLocaleTimeString() : "";
  const head = `[${ts}] ${ev}${node ? ` ${node}` : ""}`;
  const tail: string[] = [];
  if (typeof dur === "number") tail.push(`${dur}ms`);
  if (model) tail.push(String(model));
  if (usage?.totalTokens) tail.push(`${usage.totalTokens} tok`);
  if (err) tail.push(String(err).slice(0, 200));
  if (data) tail.push(String(data).slice(0, 200));
  return tail.length ? `${head} — ${tail.join(" · ")}` : head;
}

export function LogStream({ initial, streamUrl }: { initial: LogEvent[]; streamUrl: string | null }) {
  const [events, setEvents] = useState<LogEvent[]>(initial);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
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
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, paused]);

  function clear() {
    setEvents([]);
  }

  return (
    <div className="bg-ink-900 border border-zinc-800 rounded-lg overflow-hidden flex flex-col h-96">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-ink-800 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-zinc-400">Live log</span>
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? "bg-emerald-400" : "bg-zinc-600"
            }`}
            title={connected ? "connected" : "disconnected"}
          />
          <span className="text-zinc-500">({events.length} events)</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setPaused((p) => !p)}
            className="px-2 py-0.5 rounded bg-ink-700 hover:bg-ink-600"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={clear} className="px-2 py-0.5 rounded bg-ink-700 hover:bg-ink-600">
            Clear
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto scroll-thin p-2 text-xs mono leading-5"
      >
        {events.length === 0 ? (
          <div className="text-zinc-600 italic p-4">No log events yet.</div>
        ) : (
          events.map((e, i) => (
            <div key={i} className={COLOR[e.event] ?? "text-zinc-300"}>
              {fmt(e)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
