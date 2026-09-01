import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
] as const;

export type NodeStatus = "complete" | "failed" | "running" | "pending";

const STATE_META: Record<NodeStatus, { dot: string; chip: string }> = {
  complete: { dot: "bg-success", chip: "bg-success/15 text-success" },
  failed: { dot: "bg-destructive", chip: "bg-destructive/15 text-destructive" },
  running: { dot: "bg-primary animate-pulse", chip: "bg-primary/15 text-primary" },
  pending: { dot: "bg-muted-foreground/30", chip: "bg-muted text-muted-foreground" },
};

function humanize(name: string): string {
  return name.replace(/([A-Z])/g, " $1").trim();
}

export function ProgressBar({ nodeStates }: { nodeStates: Record<string, NodeStatus> }) {
  const stats = useMemo(() => {
    let done = 0;
    let failed = 0;
    let running = 0;
    for (const n of PRODUCER_NODES) {
      const s = nodeStates[n] ?? "pending";
      if (s === "complete") done++;
      else if (s === "failed") failed++;
      else if (s === "running") running++;
    }
    return { done, failed, running, total: PRODUCER_NODES.length };
  }, [nodeStates]);

  const percent = Math.round(((stats.done + stats.failed) / stats.total) * 100);
  const current =
    PRODUCER_NODES.find((n) => nodeStates[n] === "running") ??
    PRODUCER_NODES[Math.min(stats.done, PRODUCER_NODES.length - 1)];

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-foreground">Pipeline</span>
          <Badge variant="muted" className="font-mono">
            {stats.done}/{stats.total}
          </Badge>
          {stats.running > 0 && (
            <Badge variant="default" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {humanize(current)}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {stats.failed > 0 && (
            <span className="text-destructive">{stats.failed} failed</span>
          )}
          {stats.running > 0 && <span className="text-primary">{stats.running} running</span>}
          <span className="font-mono">{percent}%</span>
        </div>
      </div>
      <div className="px-4 py-3">
        <Progress value={percent} />
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-4 py-3">
        {PRODUCER_NODES.map((n) => {
          const s = nodeStates[n] ?? "pending";
          const meta = STATE_META[s];
          return (
            <span
              key={n}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                meta.chip,
              )}
              title={`${n} — ${s}`}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
              {humanize(n)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
