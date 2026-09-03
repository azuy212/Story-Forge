import { useEffect, useMemo, useState } from "react";
import { Copy, FileJson, Trash2 } from "lucide-react";
import { api, type StageArtifact } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ns: string;
  stageKey: string | null;
  stageLabel: string;
  deleteDisabled?: boolean;
  deleteHint?: string;
  onRequestDelete?: () => void;
};

export function StageArtifactDialog({
  open,
  onOpenChange,
  ns,
  stageKey,
  stageLabel,
  deleteDisabled = false,
  deleteHint,
  onRequestDelete,
}: Props) {
  const [data, setData] = useState<StageArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !stageKey) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    setVersion(null);
    api
      .getStageArtifact(ns, stageKey)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setVersion(d.version);
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, stageKey, ns]);

  useEffect(() => {
    if (!open || !stageKey || version == null || !data) return;
    if (data.version === version) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getStageArtifact(ns, stageKey, version)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [version, open, stageKey, ns, data]);

  const pretty = useMemo(() => {
    if (!data?.artifact && data?.artifact !== 0) return "";
    try {
      return JSON.stringify(data.artifact, null, 2);
    } catch {
      return String(data.artifact);
    }
  }, [data]);

  const hasMultipleVersions = (data?.versions.length ?? 0) > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                <FileJson className="h-4 w-4 text-muted-foreground" />
                {stageLabel} artifact
              </DialogTitle>
              <DialogDescription className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs">
                <span>{stageKey}</span>
                {data?.version != null && (
                  <span className="rounded bg-muted px-1.5 py-0.5">v{data.version}</span>
                )}
                {data?.sizeBytes != null && (
                  <span className="text-muted-foreground/70">{formatBytes(data.sizeBytes)}</span>
                )}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hasMultipleVersions && data && (
                <Select
                  value={version != null ? String(version) : undefined}
                  onValueChange={(v) => setVersion(Number(v))}
                >
                  <SelectTrigger className="h-8 w-[110px] text-xs">
                    <SelectValue placeholder="version" />
                  </SelectTrigger>
                  <SelectContent>
                    {[...data.versions]
                      .sort((a, b) => b.version - a.version)
                      .map((v) => (
                        <SelectItem key={v.version} value={String(v.version)}>
                          v{v.version}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
              {pretty && <CopyButton value={pretty} label="Copy artifact JSON" />}
            </div>
          </div>
        </DialogHeader>

        {loading && !data ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : data && !data.exists ? (
          <EmptyStage />
        ) : pretty ? (
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-background/50 p-3 font-mono text-xs leading-relaxed text-foreground/90 scroll-thin">
            {pretty}
          </pre>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          {onRequestDelete ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRequestDelete}
              disabled={deleteDisabled || !data?.exists || loading}
              className={cn(
                "gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive",
                "disabled:text-muted-foreground/60",
              )}
              title={deleteHint}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete stage artifact
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptyStage() {
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-card/40 px-4 py-10 text-center">
      <Copy className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">
        This stage hasn&rsquo;t produced an artifact yet.
      </p>
      <p className="mt-1 text-xs text-muted-foreground/70">
        The card will turn green when the run reaches this stage.
      </p>
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
