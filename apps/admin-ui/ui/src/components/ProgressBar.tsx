import { useMemo } from "react";

const PRODUCER_NODES = [
  "ResearchAgent",
  "ScriptPlanner",
  "ScriptWriter",
  "VisualDirector",
  "AssetStrategy",
  "ImagePromptGenerator",
  "AssetGenerator",
  "ImagePromptRepair",
  "NarrationGenerator",
  "SubtitleGenerator",
  "VideoComposer",
  "MetadataGenerator",
  "ThumbnailGenerator",
  "Publisher",
];

export type NodeStatus = "complete" | "failed" | "running" | "pending";

export function ProgressBar({ nodeStates }: { nodeStates: Record<string, NodeStatus> }) {
  const stats = useMemo(() => {
    let done = 0;
    let failed = 0;
    let running = 0;
    for (const n of PRODUCER_NODES) {
      const s = nodeStates[n] ?? "pending";
      if (s === "complete") done++;
      if (s === "failed") failed++;
      if (s === "running") running++;
    }
    return { done, failed, running, total: PRODUCER_NODES.length };
  }, [nodeStates]);

  const width = 24;
  const filled = Math.round(((stats.done + stats.failed) / stats.total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const current =
    PRODUCER_NODES.find((n) => nodeStates[n] === "running") ??
    PRODUCER_NODES[stats.done] ??
    "idle";

  return (
    <div className="bg-ink-900 border border-zinc-800 rounded-lg p-3">
      <div className="flex items-center justify-between text-xs text-zinc-400 mb-2">
        <span>Pipeline</span>
        <span>
          {stats.done}/{stats.total}
          {stats.failed > 0 && <span className="text-rose-400"> · {stats.failed} failed</span>}
        </span>
      </div>
      <div className="mono text-sm text-cyan-300">
        [{bar}] {current}
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
        {PRODUCER_NODES.map((n) => {
          const s = nodeStates[n] ?? "pending";
          const color =
            s === "complete"
              ? "bg-emerald-700 text-emerald-100"
              : s === "failed"
                ? "bg-rose-700 text-rose-100"
                : s === "running"
                  ? "bg-cyan-700 text-cyan-100 animate-pulse"
                  : "bg-ink-800 text-zinc-500";
          return (
            <span key={n} className={`px-1.5 py-0.5 rounded ${color}`}>
              {n.replace(/([A-Z])/g, " $1").trim()}
            </span>
          );
        })}
      </div>
    </div>
  );
}
