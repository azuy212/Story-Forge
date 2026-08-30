import type { StageStatus } from "../api";

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
];

const ICON: Record<StageStatus, string> = {
  complete: "✓",
  seeded: "◇",
  missing: "○",
  pending: "⏳",
  failed: "✗",
  unknown: "?",
};

const COLOR: Record<StageStatus, string> = {
  complete: "bg-emerald-700/40 border-emerald-600 text-emerald-200",
  seeded: "bg-sky-700/30 border-sky-600 text-sky-200",
  missing: "bg-ink-800 border-zinc-700 text-zinc-400",
  pending: "bg-amber-700/30 border-amber-600 text-amber-200",
  failed: "bg-rose-700/40 border-rose-600 text-rose-200",
  unknown: "bg-ink-800 border-zinc-700 text-zinc-500",
};

export function StageGrid({ stages }: { stages: Record<string, StageStatus> }) {
  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
      {STAGES.map((s) => {
        const status = stages[s.key] ?? "missing";
        return (
          <div
            key={s.key}
            className={`rounded border px-2 py-2 text-xs flex items-center gap-2 ${COLOR[status]}`}
            title={`${s.key}: ${status}`}
          >
            <span className="text-base leading-none">{ICON[status]}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{s.label}</div>
              <div className="opacity-60 text-[10px] uppercase tracking-wider">{status}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
