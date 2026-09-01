import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
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
import { api, type LogEvent, type RunDetail as RunDetailT, type RunStatus } from "@/lib/api";
import { StageGrid } from "@/components/StageGrid";
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
import { cn, formatDateTime, truncate } from "@/lib/utils";

type Props = { ns: string; onBack: () => void };

export function RunDetail({ ns, onBack }: Props) {
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"cancel" | "abort" | "delete" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
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
        title={meta.topic as string ?? "Run detail"}
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
                <Button variant="outline" size="icon" disabled={actionBusy} aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Run actions</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    withAction(() => api.resumeRun(ns), "Resumed")
                  }
                >
                  <Play className="h-4 w-4" /> Resume
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setResumeOpen(true)}>
                  <Plus className="h-4 w-4" /> Resume with overrides
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    withAction(() => api.resumeRun(ns, { dryRun: true }), "Dry-run complete")
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
        <Section title="Pipeline progress" icon={Workflow} description="Producer node status from live SSE events.">
          <PipelineProgress ns={ns} />
        </Section>

        <Section title="Stage status" icon={CheckCircle2} description="Per-stage artifact availability.">
          <StageGrid stages={detail.stages} />
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
              <MetaRow label="Topic" value={(meta.topic as string) ?? null} copyable />
              <MetaRow label="Pillar" value={(meta.pillar as string) ?? null} />
              <MetaRow label="Profile" value={(meta.videoProfile as string) ?? null} />
              <MetaRow label="Source" value={(meta.runSource as string) ?? "backlog"} />
              <MetaRow label="Project ID" value={(meta.projectId as string) ?? null} mono />
              <MetaRow
                label="Publish at"
                value={formatDateTime(meta.youtubePublishAt as string | null)}
              />
              <MetaRow label="Created" value={formatDateTime(meta.createdAt as string | null)} />
              <MetaRow label="Aborted" value={formatDateTime(meta.abortedAt as string | null)} />
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
                <div className="text-sm text-muted-foreground/60">No thread history yet.</div>
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
          title="Generated assets"
          icon={FileSearch}
          description="Video, audio, subtitles, scene images, thumbnail, and metadata."
        >
          <AssetsPanel ns={ns} />
        </Section>

        <Section title="Live log" icon={Workflow} description="Streaming SSE console for this run.">
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

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "delete" && "Delete run"}
              {confirmAction === "abort" && "Abort run"}
              {confirmAction === "cancel" && "Cancel running child"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "delete" &&
                `This will permanently remove ${ns} and all generated assets. This action cannot be undone.`}
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
                  withAction(() => api.deleteRun(ns).then(onBack), "Run deleted");
                } else if (confirmAction === "abort") {
                  withAction(() => api.abortRun(ns), "Run aborted");
                } else if (confirmAction === "cancel") {
                  withAction(() => api.cancelRun(ns), "Child cancelled");
                }
                setConfirmAction(null);
              }}
              className={cn(
                confirmAction === "delete" || confirmAction === "abort"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "",
              )}
            >
              {confirmAction === "delete" && "Delete"}
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
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
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
    const es = new EventSource(`/api/orchestrator/runs/${encodeURIComponent(ns)}/stream`);
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
  return <LogStream initial={initial} streamUrl={`/api/orchestrator/runs/${encodeURIComponent(ns)}/stream`} />;
}

function AssetsPanel({ ns }: { ns: string }) {
  const [assets, setAssets] = useState<Awaited<ReturnType<typeof api.getAssets>> | null>(null);
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
            Update pillar, topic, video profile, project ID, or scheduled publish time.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pillar">
            <Input
              value={form.pillar}
              onChange={(e) => setForm((s) => ({ ...s, pillar: e.target.value }))}
              placeholder="Psychology"
            />
          </Field>
          <Field label="Topic">
            <Input
              value={form.topic}
              onChange={(e) => setForm((s) => ({ ...s, topic: e.target.value }))}
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
              onChange={(e) => setForm((s) => ({ ...s, projectId: e.target.value }))}
              placeholder="row id"
            />
          </Field>
          <Field label="Publish at (ISO 8601)" className="sm:col-span-2">
            <Input
              value={form.youtubePublishAt}
              onChange={(e) => setForm((s) => ({ ...s, youtubePublishAt: e.target.value }))}
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
  });
  const [busy, setBusy] = useState(false);

  async function onRun() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (form.pillar) body.pillar = form.pillar;
      if (form.topic) body.topic = form.topic;
      if (form.profile) body.profile = form.profile;
      if (form.seed) body.seed = form.seed;
      if (form.dryRun) body.dryRun = true;
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
            Override pillar, topic, profile, or pass a seed file. Empty fields are ignored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pillar">
            <Input
              value={form.pillar}
              onChange={(e) => setForm((s) => ({ ...s, pillar: e.target.value }))}
              placeholder="Psychology"
            />
          </Field>
          <Field label="Topic">
            <Input
              value={form.topic}
              onChange={(e) => setForm((s) => ({ ...s, topic: e.target.value }))}
              placeholder="Why your brain…"
            />
          </Field>
          <Field label="Profile">
            <Select value={form.profile} onValueChange={(v) => setForm((s) => ({ ...s, profile: v }))}>
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
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="dry-run"
            checked={form.dryRun}
            onChange={(e) => setForm((s) => ({ ...s, dryRun: e.target.checked }))}
            className="h-4 w-4 rounded border-input bg-background accent-primary"
          />
          <Label htmlFor="dry-run" className="cursor-pointer normal-case tracking-normal">
            Dry-run only
          </Label>
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
