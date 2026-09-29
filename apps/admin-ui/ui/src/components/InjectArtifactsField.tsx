import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { InjectArtifact } from "@/lib/api";

export const INJECT_ARTIFACT_TYPES = [
  "research",
  "researchQA",
  "scriptPlan",
  "script",
  "scriptQA",
  "visualDirector",
  "metadata",
  "thumbnail",
  "thumbnailImage",
  "prompts",
  "promptQA",
  "assets",
  "audio",
  "subtitles",
  "videoPlan",
  "releaseValidation",
  "releaseReview",
  "publish",
] as const;

export type InjectArtifactDraft = {
  id: number;
  type: string;
  mode: "path" | "json";
  path: string;
  json: string;
};

let draftSeq = 1;

export function newInjectDraft(
  type: string = INJECT_ARTIFACT_TYPES[0],
): InjectArtifactDraft {
  return { id: draftSeq++, type, mode: "path", path: "", json: "" };
}

export function collectInjectArtifacts(
  drafts: InjectArtifactDraft[],
):
  | { ok: true; artifacts: InjectArtifact[] }
  | { ok: false; error: string } {
  const artifacts: InjectArtifact[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const type = d.type.trim();
    if (!type) {
      return { ok: false, error: "Each injection needs an artifact type." };
    }
    if (seen.has(type)) {
      return { ok: false, error: `Duplicate injection for "${type}".` };
    }
    seen.add(type);
    if (d.mode === "path") {
      const path = d.path.trim();
      if (!path) {
        return { ok: false, error: `File path required for "${type}".` };
      }
      artifacts.push({ type, path });
    } else {
      const json = d.json.trim();
      if (!json) {
        return { ok: false, error: `Pasted JSON required for "${type}".` };
      }
      try {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            ok: false,
            error: `Payload for "${type}" must be a JSON object.`,
          };
        }
      } catch (e) {
        return { ok: false, error: `Invalid JSON for "${type}": ${(e as Error).message}` };
      }
      artifacts.push({ type, json });
    }
  }
  return { ok: true, artifacts };
}

export function InjectArtifactsField({
  drafts,
  onChange,
}: {
  drafts: InjectArtifactDraft[];
  onChange: (drafts: InjectArtifactDraft[]) => void;
}) {
  function patch(id: number, next: Partial<InjectArtifactDraft>) {
    onChange(drafts.map((d) => (d.id === id ? { ...d, ...next } : d)));
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>Manual artifact overrides</Label>
        <p className="text-xs text-muted-foreground">
          Serve a local payload in place of that node&apos;s LLM call for this
          run — unstick a producer or QA gate. Point at a file path, or paste
          the node&apos;s JSON output directly (written to a temp file
          server-side). Must be re-passed on every resume while needed.
        </p>
      </div>
      {drafts.map((d) => (
        <div key={d.id} className="flex flex-wrap items-end gap-2">
          <div className="w-44 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select value={d.type} onValueChange={(v) => patch(d.id, { type: v })}>
              <SelectTrigger className="font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INJECT_ARTIFACT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {d.mode === "path" ? "File path" : "Payload JSON"}
            </Label>
            {d.mode === "path" ? (
              <Input
                value={d.path}
                onChange={(e) => patch(d.id, { path: e.target.value })}
                placeholder="/abs/path/to/payload.json"
                className="font-mono"
              />
            ) : (
              <Textarea
                value={d.json}
                onChange={(e) => patch(d.id, { json: e.target.value })}
                placeholder='{"status":"approved", ...}'
                rows={3}
                className="font-mono text-xs"
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                patch(d.id, {
                  mode: d.mode === "path" ? "json" : "path",
                })
              }
            >
              {d.mode === "path" ? "Paste JSON" : "Use path"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove injection"
              onClick={() => onChange(drafts.filter((x) => x.id !== d.id))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...drafts, newInjectDraft()])}
      >
        <Plus className="h-3.5 w-3.5" /> Add injection
      </Button>
    </div>
  );
}
