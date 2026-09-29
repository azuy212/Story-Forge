import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Coins,
  Edit,
  FileSearch,
  FlaskConical,
  History,
  Info,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  StopCircle,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  api,
  type LogEvent,
  type LlmCostSummary,
  type RunDetail as RunDetailT,
  type RunStatus,
} from "@/lib/api";
import { StageGrid, STAGES } from "@/components/StageGrid";
import { StageArtifactDialog } from "@/components/StageArtifactDialog";
import {
  InjectArtifactsField,
  collectInjectArtifacts,
  type InjectArtifactDraft,
} from "@/components/InjectArtifactsField";
import { LogStream } from "@/components/LogStream";
import { ProgressBar, type NodeStatus } from "@/components/ProgressBar";
import { AssetsGallery } from "@/components/AssetsGallery";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { MetaRow } from "@/components/shared/copy-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/toast";
import { cn, formatDateTime, formatUsd, truncate } from "@/lib/utils";

type Props = { ns: string; onBack: () => void };

export function RunDetail({ ns, onBack }: Props) {
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    "cancel" | "abort" | "delete" | "deleteArtifact" | null
  >(null);
  const [editOpen, setEditOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [artifactStage, setArtifactStage] = useState<string | null>(null);
  const statusRef = useRef<RunStatus | null>(null);
  useEffect(() => {
    statusRef.current = detail?.status ?? null;
  }, [detail?.status]);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setInterval> | null = null;
    const load = () =>
      api
        .getRun(ns)
        .then((d) => {
          if (!alive) return;
          setDetail(d);
          if (d.status === "published" && t) {
            clearInterval(t);
            t = null;
          }
        })
        .catch((e) => alive && setError(e.message));
    load();
    t = setInterval(load, 4000);
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [ns]);

  if (error) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-3.5 w-3.5" /> Runs
        </Button>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-3.5 w-3.5" /> Runs
        </Button>
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  const meta = detail.meta;
  const threadHistory = (meta.threadHistory as string[] | undefined) ?? [];

  async function withAction(fn: () => Promise<unknown>, success: string) {
    setActionBusy(true);
    try {
      await fn();
      toast.success(success);
    } catch (e) {
      toast.error("Action failed", (e as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  const primary = pickPrimary(detail.status, ns);

  return (
    <div className="space-y-6">
      <PageHeader
        title={(meta.topic as string) ?? "Run detail"}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs">{ns}</span>
            <StatusBadge status={detail.status} />
            {detail.childStatus && (
              <Badge variant="muted" className="font-mono text-[10px]">
                child: {detail.childStatus}
              </Badge>
            )}
            {typeof meta.videoProfile === "string" && meta.videoProfile && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {meta.videoProfile}
              </Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" onClick={onBack} className="gap-1.5">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
            {primary && (
              <Button
                variant={primary.variant}
                disabled={actionBusy}
                onClick={primary.onClick}
                className="gap-1.5"
              >
                <primary.icon className="h-4 w-4" /> {primary.label}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={actionBusy}
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Run actions</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => withAction(() => api.resumeRun(ns), "Resumed")}
                >
                  <Play className="h-4 w-4" /> Resume
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setResumeOpen(true)}>
                  <Plus className="h-4 w-4" /> Resume with overrides
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    withAction(
                      () => api.resumeRun(ns, { dryRun: true }),
                      "Dry-run complete",
                    )
                  }
                >
                  <FlaskConical className="h-4 w-4" /> Dry-run resume
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setConfirmAction("cancel")}
                  disabled={detail.status !== "running"}
                >
                  <Pause className="h-4 w-4" /> Cancel child
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setConfirmAction("abort")}
                  variant="destructive"
                >
                  <StopCircle className="h-4 w-4" /> Abort
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setEditOpen(true)}>
                  <Edit className="h-4 w-4" /> Edit metadata
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setConfirmAction("delete")}
                  variant="destructive"
                >
                  <Trash2 className="h-4 w-4" /> Delete run
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="space-y-6 px-4 pb-10 sm:px-6">
        <Section
          title="Pipeline progress"
          icon={Workflow}
          description="Producer node status from live SSE events."
        >
          <PipelineProgress ns={ns} />
        </Section>

        <Section
          title="Stage status"
          icon={CheckCircle2}
          description="Per-stage artifact availability."
        >
          <StageGrid stages={detail.stages} onSelect={setArtifactStage} />
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Run metadata</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <MetaRow
                label="Topic"
                value={(meta.topic as string) ?? null}
                copyable
              />
              <MetaRow label="Pillar" value={(meta.pillar as string) ?? null} />
              <MetaRow
                label="Profile"
                value={(meta.videoProfile as string) ?? null}
              />
              <MetaRow
                label="Source"
                value={(meta.runSource as string) ?? "backlog"}
              />
              <MetaRow
                label="Project ID"
                value={(meta.projectId as string) ?? null}
                mono
              />
              <MetaRow
                label="Publish at"
                value={formatDateTime(meta.youtubePublishAt as string | null)}
              />
              <MetaRow
                label="Created"
                value={formatDateTime(meta.createdAt as string | null)}
              />
              <MetaRow
                label="Aborted"
                value={formatDateTime(meta.abortedAt as string | null)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Thread history</CardTitle>
                <Badge variant="muted" className="font-mono">
                  {threadHistory.length}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {threadHistory.length === 0 ? (
                <div className="text-sm text-muted-foreground/60">
                  No thread history yet.
                </div>
              ) : (
                <ol className="space-y-1 font-mono text-xs text-foreground/80">
                  {threadHistory.map((t, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="w-6 shrink-0 text-right text-muted-foreground/60">
                        {i + 1}.
                      </span>
                      <span className="break-words">{t}</span>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <Section
          title="LLM cost"
          icon={Coins}
          description="Token spend across every agent that called the model. Per-stage breakdown of completed LLM invocations."
        >
          <LlmCostPanel llmCost={detail.llmCost} />
        </Section>

        <Section
          title="Generated assets"
          icon={FileSearch}
          description="Video, audio, subtitles, scene images, thumbnail, and metadata."
        >
          <AssetsPanel ns={ns} />
        </Section>

        <Section
          title="Live log"
          icon={Workflow}
          description="Streaming SSE console for this run."
        >
          <LogPanel ns={ns} />
        </Section>
      </div>

      <EditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        meta={meta}
        ns={ns}
        onSaved={() => {
          toast.success("Run metadata saved");
        }}
      />

      <ResumeDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        ns={ns}
        onResumed={() => toast.success("Resume queued")}
      />

      <StageArtifactDialog
        open={artifactStage !== null}
        onOpenChange={(o) => !o && setArtifactStage(null)}
        ns={ns}
        stageKey={artifactStage}
        stageLabel={
          STAGES.find((s) => s.key === artifactStage)?.label ??
          artifactStage ??
          ""
        }
        deleteDisabled={detail.status === "running"}
        deleteHint={
          detail.status === "running"
            ? "Cannot delete while the run is active"
            : undefined
        }
        onRequestDelete={() => setConfirmAction("deleteArtifact")}
      />

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "delete" && "Delete run"}
              {confirmAction === "deleteArtifact" &&
                `Delete ${STAGES.find((s) => s.key === artifactStage)?.label ?? artifactStage ?? "stage"} artifact`}
              {confirmAction === "abort" && "Abort run"}
              {confirmAction === "cancel" && "Cancel running child"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "delete" &&
                `This will permanently remove ${ns} and all generated assets. This action cannot be undone.`}
              {confirmAction === "deleteArtifact" &&
                `Removes all stored versions for this stage and clears the manifest entry. The next resume will recompute this stage from scratch. This action cannot be undone.`}
              {confirmAction === "abort" &&
                `Stops the child process (if running) and writes abortedAt to run.json for ${ns}.`}
              {confirmAction === "cancel" &&
                `Sends SIGTERM to the running child for ${ns}. The run stays on disk and can be resumed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmAction === "delete") {
                  withAction(
                    () => api.deleteRun(ns).then(onBack),
                    "Run deleted",
                  );
                } else if (
                  confirmAction === "deleteArtifact" &&
                  artifactStage
                ) {
                  const stage = artifactStage;
                  withAction(async () => {
                    const r = await api.deleteStageArtifact(ns, stage);
                    setArtifactStage(null);
                    return r;
                  }, "Stage artifact deleted");
                } else if (confirmAction === "abort") {
                  withAction(() => api.abortRun(ns), "Run aborted");
                } else if (confirmAction === "cancel") {
                  withAction(() => api.cancelRun(ns), "Child cancelled");
                }
                setConfirmAction(null);
              }}
              className={cn(
                confirmAction === "delete" ||
                  confirmAction === "deleteArtifact" ||
                  confirmAction === "abort"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "",
              )}
            >
              {confirmAction === "delete" && "Delete"}
              {confirmAction === "deleteArtifact" && "Delete stage"}
              {confirmAction === "abort" && "Abort"}
              {confirmAction === "cancel" && "Cancel child"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function pickPrimary(
  status: RunStatus,
  ns: string,
): {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  variant: "default" | "destructive" | "outline" | "secondary";
  onClick: () => void;
} | null {
  if (status === "running" || status === "published") return null;
  return {
    label: "Resume",
    icon: Play,
    variant: "default",
    onClick: () => {
      api
        .resumeRun(ns)
        .then(() => toast.success("Resumed"))
        .catch((e) => toast.error("Resume failed", (e as Error).message));
    },
  };
}

function Section({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

function PipelineProgress({ ns }: { ns: string }) {
  const [events, setEvents] = useState<LogEvent[]>([]);

  useEffect(() => {
    let alive = true;
    api.tailLog(ns, 0).then((t) => {
      if (alive) setEvents(t.lines);
    });
    return () => {
      alive = false;
    };
  }, [ns]);

  useEffect(() => {
    let alive = true;
    const es = new EventSource(
      `/api/orchestrator/runs/${encodeURIComponent(ns)}/stream`,
    );
    const onMsg = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as LogEvent;
        if (
          data.event === "node_start" ||
          data.event === "node_end" ||
          data.event === "node_failed"
        ) {
          if (alive) setEvents((prev) => [...prev, data]);
        }
      } catch {
        // ignore
      }
    };
    es.addEventListener("log", onMsg);
    es.addEventListener("stderr", onMsg);
    es.addEventListener("error", onMsg);
    return () => {
      alive = false;
      es.close();
    };
  }, [ns]);

  const nodeStates = useMemo(() => {
    const states: Record<string, NodeStatus> = {};
    for (const ev of events) {
      const n = (ev as Record<string, unknown>).node as string | undefined;
      if (!n) continue;
      if (ev.event === "node_start") states[n] = "running";
      else if (ev.event === "node_end") states[n] = "complete";
      else if (ev.event === "node_failed") states[n] = "failed";
    }
    return states;
  }, [events]);

  return <ProgressBar nodeStates={nodeStates} />;
}

function LogPanel({ ns }: { ns: string }) {
  const [initial, setInitial] = useState<LogEvent[]>([]);
  useEffect(() => {
    let alive = true;
    api.tailLog(ns, 0).then((t) => {
      if (alive) setInitial(t.lines);
    });
    return () => {
      alive = false;
    };
  }, [ns]);
  return (
    <LogStream
      initial={initial}
      streamUrl={`/api/orchestrator/runs/${encodeURIComponent(ns)}/stream`}
    />
  );
}

function AssetsPanel({ ns }: { ns: string }) {
  const [assets, setAssets] = useState<Awaited<
    ReturnType<typeof api.getAssets>
  > | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .getAssets(ns)
        .then((a) => alive && setAssets(a))
        .catch(() => alive && setAssets(null));
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ns]);
  return <AssetsGallery assets={assets} />;
}

function LlmCostPanel({ llmCost }: { llmCost: LlmCostSummary }) {
  const total = llmCost.totalCostUsd;
  const stages = useMemo(() => {
    return Object.entries(llmCost.perStage)
      .map(([node, v]) => ({ node, ...v }))
      .sort((a, b) => {
        // Missing-cost entries sink to the end; otherwise descending by cost.
        if (a.costUsd == null && b.costUsd == null)
          return a.node.localeCompare(b.node);
        if (a.costUsd == null) return 1;
        if (b.costUsd == null) return -1;
        return b.costUsd - a.costUsd;
      });
  }, [llmCost.perStage]);

  const models = useMemo(() => {
    return Object.entries(llmCost.perModel)
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => {
        if (a.costUsd == null && b.costUsd == null)
          return a.model.localeCompare(b.model);
        if (a.costUsd == null) return 1;
        if (b.costUsd == null) return -1;
        return b.costUsd - a.costUsd;
      });
  }, [llmCost.perModel]);

  const hasAny =
    llmCost.requestCount > 0 || stages.length > 0 || models.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <CostMetric
          label="Total cost"
          value={formatUsd(total)}
          tone={total == null ? "muted" : "primary"}
        />
        <CostMetric
          label="LLM calls"
          value={llmCost.requestCount.toLocaleString()}
          tone="muted"
        />
        <CostMetric
          label="Stages reporting cost"
          value={stages.filter((s) => s.costUsd != null).length.toString()}
          tone="muted"
          hint={
            stages.length > 0 ? `of ${stages.length} total stages` : undefined
          }
        />
      </div>

      {!hasAny ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground/70">
          No LLM usage recorded yet for this run.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <BreakdownCard
            title="By stage"
            emptyMessage="No stage usage yet."
            rows={stages.map((s) => ({
              key: s.node,
              label: s.node,
              requests: s.requests,
              costUsd: s.costUsd,
              fraction:
                total != null && s.costUsd != null ? s.costUsd / total : null,
            }))}
            totalCostUsd={total}
          />
          <BreakdownCard
            title="By model"
            emptyMessage="No model usage yet."
            rows={models.map((m) => ({
              key: m.model,
              label: m.model,
              requests: m.requests,
              costUsd: m.costUsd,
              fraction:
                total != null && m.costUsd != null ? m.costUsd / total : null,
            }))}
            totalCostUsd={total}
          />
        </div>
      )}
    </div>
  );
}

function CostMetric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "primary" | "muted";
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            tone === "primary"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Coins className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="truncate font-mono text-base font-semibold">{value}</p>
          {hint && (
            <p className="text-[11px] text-muted-foreground/70">{hint}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownCard({
  title,
  emptyMessage,
  rows,
  totalCostUsd,
}: {
  title: string;
  emptyMessage: string;
  rows: Array<{
    key: string;
    label: string;
    requests: number;
    costUsd: number | null;
    fraction: number | null;
  }>;
  totalCostUsd: number | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge variant="muted" className="font-mono text-[10px]">
            {rows.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground/60">{emptyMessage}</div>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.key} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono" title={row.label}>
                    {row.label}
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className="text-muted-foreground/70">
                      {row.requests} call{row.requests === 1 ? "" : "s"}
                    </span>
                    <span className="font-medium">
                      {formatUsd(row.costUsd)}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  {row.fraction != null &&
                  totalCostUsd != null &&
                  totalCostUsd > 0 ? (
                    <div
                      className="h-full bg-primary/70"
                      style={{
                        width: `${Math.min(100, Math.max(0, row.fraction * 100))}%`,
                      }}
                    />
                  ) : (
                    <div className="h-full w-full bg-muted-foreground/15" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EditDialog({
  open,
  onOpenChange,
  meta,
  ns,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  meta: Record<string, unknown>;
  ns: string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    pillar: "",
    topic: "",
    videoProfile: "short",
    projectId: "",
    youtubePublishAt: "",
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        pillar: (meta.pillar as string) ?? "",
        topic: (meta.topic as string) ?? "",
        videoProfile: (meta.videoProfile as string) ?? "short",
        projectId: (meta.projectId as string) ?? "",
        youtubePublishAt: (meta.youtubePublishAt as string) ?? "",
      });
    }
  }, [open, meta]);

  async function onSave() {
    setBusy(true);
    try {
      await api.patchRun(ns, {
        pillar: form.pillar || null,
        topic: form.topic || null,
        videoProfile: form.videoProfile,
        projectId: form.projectId || null,
        youtubePublishAt: form.youtubePublishAt || null,
      });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error("Save failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit run metadata</DialogTitle>
          <DialogDescription>
            Update pillar, topic, video profile, project ID, or scheduled
            publish time.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pillar">
            <Input
              value={form.pillar}
              onChange={(e) =>
                setForm((s) => ({ ...s, pillar: e.target.value }))
              }
              placeholder="Psychology"
            />
          </Field>
          <Field label="Topic">
            <Input
              value={form.topic}
              onChange={(e) =>
                setForm((s) => ({ ...s, topic: e.target.value }))
              }
              placeholder="Why your brain…"
            />
          </Field>
          <Field label="Profile">
            <Select
              value={form.videoProfile}
              onValueChange={(v) => setForm((s) => ({ ...s, videoProfile: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="short">short</SelectItem>
                <SelectItem value="long">long</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Project ID">
            <Input
              value={form.projectId}
              onChange={(e) =>
                setForm((s) => ({ ...s, projectId: e.target.value }))
              }
              placeholder="row id"
            />
          </Field>
          <Field label="Publish at (ISO 8601)" className="sm:col-span-2">
            <Input
              value={form.youtubePublishAt}
              onChange={(e) =>
                setForm((s) => ({ ...s, youtubePublishAt: e.target.value }))
              }
              placeholder="2025-01-01T00:00:00Z"
              className="font-mono"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResumeDialog({
  open,
  onOpenChange,
  ns,
  onResumed,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ns: string;
  onResumed: () => void;
}) {
  const [form, setForm] = useState({
    pillar: "",
    topic: "",
    profile: "short",
    seed: "",
    dryRun: false,
    resetQaRetries: false,
  });
  const [injectDrafts, setInjectDrafts] = useState<InjectArtifactDraft[]>([]);
  const [busy, setBusy] = useState(false);

  async function onRun() {
    const inject = collectInjectArtifacts(injectDrafts);
    if (!inject.ok) {
      toast.error("Invalid artifact injection", inject.error);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (form.pillar) body.pillar = form.pillar;
      if (form.topic) body.topic = form.topic;
      if (form.profile) body.profile = form.profile;
      if (form.seed) body.seed = form.seed;
      if (form.dryRun) body.dryRun = true;
      if (form.resetQaRetries) body.resetQaRetries = true;
      if (inject.artifacts.length) body.injectArtifacts = inject.artifacts;
      await api.resumeRun(ns, body);
      onOpenChange(false);
      onResumed();
    } catch (e) {
      toast.error("Resume failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resume with overrides</DialogTitle>
          <DialogDescription>
            Override pillar, topic, profile, or pass a seed file. Empty fields
            are ignored. Reset QA retries clears the last QC step's cached
            artifacts so it re-runs with a fresh retry budget.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pillar">
            <Input
              value={form.pillar}
              onChange={(e) =>
                setForm((s) => ({ ...s, pillar: e.target.value }))
              }
              placeholder="Psychology"
            />
          </Field>
          <Field label="Topic">
            <Input
              value={form.topic}
              onChange={(e) =>
                setForm((s) => ({ ...s, topic: e.target.value }))
              }
              placeholder="Why your brain…"
            />
          </Field>
          <Field label="Profile">
            <Select
              value={form.profile}
              onValueChange={(v) => setForm((s) => ({ ...s, profile: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="short">short</SelectItem>
                <SelectItem value="long">long</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Seed path">
            <Input
              value={form.seed}
              onChange={(e) => setForm((s) => ({ ...s, seed: e.target.value }))}
              placeholder="/abs/path/to/seed.json"
              className="font-mono"
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="dry-run"
              checked={form.dryRun}
              onChange={(e) =>
                setForm((s) => ({ ...s, dryRun: e.target.checked }))
              }
              className="h-4 w-4 rounded border-input bg-background accent-primary"
            />
            <Label
              htmlFor="dry-run"
              className="cursor-pointer normal-case tracking-normal"
            >
              Dry-run only
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="reset-qa-retries"
              checked={form.resetQaRetries}
              onChange={(e) =>
                setForm((s) => ({ ...s, resetQaRetries: e.target.checked }))
              }
              className="h-4 w-4 rounded border-input bg-background accent-primary"
            />
            <Label
              htmlFor="reset-qa-retries"
              className="cursor-pointer normal-case tracking-normal"
            >
              Reset QA retries for last step
            </Label>
          </div>
        </div>
        <div className="space-y-3 border-t pt-3">
          <InjectArtifactsField
            drafts={injectDrafts}
            onChange={setInjectDrafts}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onRun} disabled={busy}>
            {form.dryRun ? "Run dry-resume" : "Resume"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
