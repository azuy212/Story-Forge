import type { StageStatus } from "@/lib/api";
import { CheckCircle2, Circle, CircleDashed, Clock, XCircle, HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const STAGES = [
  { key: "research", label: "Research" },
  { key: "researchQA", label: "Research QA" },
  { key: "scriptPlan", label: "Script Plan" },
  { key: "script", label: "Script" },
  { key: "scriptQA", label: "Script QA" },
  { key: "metadata", label: "Metadata" },
  { key: "thumbnail", label: "Thumbnail" },
  { key: "visualDirector", label: "Visual Director" },
  { key: "thumbnailImage", label: "Thumbnail Image" },
  { key: "prompts", label: "Prompts" },
  { key: "promptQA", label: "Prompt QA" },
  { key: "assets", label: "Assets" },
  { key: "audio", label: "Audio" },
  { key: "subtitles", label: "Subtitles" },
  { key: "videoPlan", label: "Video Plan" },
  { key: "releaseValidation", label: "Release Validation" },
  { key: "releaseReview", label: "Release Review" },
  { key: "publish", label: "Publish" },
] as const;

const META: Record<
  StageStatus,
  { icon: React.ComponentType<{ className?: string }>; tone: string; ring: string; chip: string }
> = {
  complete: {
    icon: CheckCircle2,
    tone: "text-success",
    ring: "ring-success/40 bg-success/10",
    chip: "bg-success/15 text-success",
  },
  seeded: {
    icon: CircleDashed,
    tone: "text-chart-4",
    ring: "ring-chart-4/40 bg-chart-4/10",
    chip: "bg-chart-4/15 text-chart-4",
  },
  missing: {
    icon: Circle,
    tone: "text-muted-foreground/50",
    ring: "ring-border/50 bg-card/40",
    chip: "bg-muted text-muted-foreground",
  },
  pending: {
    icon: Clock,
    tone: "text-warning",
    ring: "ring-warning/40 bg-warning/5",
    chip: "bg-warning/15 text-warning",
  },
  failed: {
    icon: XCircle,
    tone: "text-destructive",
    ring: "ring-destructive/40 bg-destructive/10",
    chip: "bg-destructive/15 text-destructive",
  },
  unknown: {
    icon: HelpCircle,
    tone: "text-muted-foreground/40",
    ring: "ring-border/50 bg-card/40",
    chip: "bg-muted text-muted-foreground",
  },
};

export function StageGrid({ stages }: { stages: Record<string, StageStatus> }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {STAGES.map((s) => {
        const status = stages[s.key] ?? "missing";
        const meta = META[status];
        const Icon = meta.icon;
        return (
          <Tooltip key={s.key}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "group flex items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/60 hover:bg-card/60",
                  "ring-1 ring-inset",
                  meta.ring,
                )}
              >
                <Icon className={cn("h-4 w-4 shrink-0", meta.tone)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{s.label}</div>
                  <div
                    className={cn(
                      "mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider",
                      meta.chip,
                    )}
                  >
                    {status}
                  </div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="font-mono">{s.key}</span> · {status}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
