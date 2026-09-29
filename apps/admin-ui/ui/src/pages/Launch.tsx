import { useState } from "react";
import { ArrowRight, CalendarClock, FileUp, Layers3, ListOrdered, Play, Rocket, Sparkles, Tag, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { useSheet } from "@/hooks/use-sheet";
import { PageHeader } from "@/components/shared/page-header";
import {
  InjectArtifactsField,
  collectInjectArtifacts,
  type InjectArtifactDraft,
} from "@/components/InjectArtifactsField";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Tab = "next" | "seed";

export function Launch({ onLaunched }: { onLaunched: (ns: string) => void }) {
  const [tab, setTab] = useState<Tab>("next");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Launch"
        description="Trigger the pipeline — pull from the backlog or feed pre-written research via a seed file."
      />
      <div className="space-y-6 px-4 sm:px-6">
        <NextInLineStrip />
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="next">
              <Rocket className="h-3.5 w-3.5" /> Run Next
            </TabsTrigger>
            <TabsTrigger value="seed">
              <FileUp className="h-3.5 w-3.5" /> Seed Run
            </TabsTrigger>
          </TabsList>
          <TabsContent value="next">
            <RunNextForm onLaunched={onLaunched} />
          </TabsContent>
          <TabsContent value="seed">
            <SeedForm onLaunched={onLaunched} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function NextInLineStrip() {
  const sheet = useSheet();
  const short = sheet.nextInLine("short");
  const long = sheet.nextInLine("long");

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <NextInLineCard profile="short" next={short} loading={sheet.loading} />
      <NextInLineCard profile="long" next={long} loading={sheet.loading} />
    </div>
  );
}

function NextInLineCard({
  profile,
  next,
  loading,
}: {
  profile: "short" | "long";
  next: ReturnType<ReturnType<typeof useSheet>["nextInLine"]>;
  loading: boolean;
}) {
  const Icon = profile === "short" ? Zap : Layers3;
  const label = profile === "short" ? "Short video" : "Long video";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Next in line — {label}</CardTitle>
          </div>
          <Badge variant="outline" className="capitalize">
            {profile}
          </Badge>
        </div>
        <CardDescription>
          First planned row in the sheet. The launcher picks this one when you press Run Next.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !next ? (
          <div className="space-y-2">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : !next || !next.rowExists ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
            <ListOrdered className="h-4 w-4" />
            <span>No planned rows in this sheet.</span>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium leading-snug text-foreground">{next.topic}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Tag className="h-3 w-3" />
                {next.category || "no category"}
              </span>
              <span className="inline-flex items-center gap-1 font-mono">
                <span className="text-muted-foreground/70">id</span>
                {next.videoId || "—"}
              </span>
              {next.scheduledAtLocal ? (
                <span className="inline-flex items-center gap-1 font-mono">
                  <CalendarClock className="h-3 w-3" />
                  {next.scheduledAtLocal}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <CalendarClock className="h-3 w-3" />
                  no slot yet
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RunNextForm({ onLaunched }: { onLaunched: (ns: string) => void }) {
  const [profile, setProfile] = useState<"short" | "long">("short");
  const [injectDrafts, setInjectDrafts] = useState<InjectArtifactDraft[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    const inject = collectInjectArtifacts(injectDrafts);
    if (!inject.ok) {
      toast.error("Invalid artifact injection", inject.error);
      return;
    }
    setBusy(true);
    try {
      const r = await api.launchRunNext(profile, false, inject.artifacts);
      if (r.none) {
        toast.warning(
          "Nothing to launch",
          r.reason === "no-pending-row"
            ? "No pending planned rows in the backlog."
            : "No free publish slot within 30 days.",
        );
        return;
      }
      toast.success("Run launched", r.ns);
      onLaunched(r.ns);
    } catch (e) {
      toast.error("Launch failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Run next from backlog</CardTitle>
        </div>
        <CardDescription>
          Reads the Google Sheets backlog, picks the first pending planned row, and runs it. If a run
          already exists for that topic, resumes it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr]">
          <div className="space-y-1.5">
            <Label>Profile</Label>
            <Select value={profile} onValueChange={(v) => setProfile(v as "short" | "long")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="short">short</SelectItem>
                <SelectItem value="long">long</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="border-t pt-4">
          <InjectArtifactsField
            drafts={injectDrafts}
            onChange={setInjectDrafts}
          />
        </div>
        <Button onClick={onSubmit} disabled={busy}>
          {busy ? "Launching…" : "Launch next"}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </CardContent>
    </Card>
  );
}

function SeedForm({ onLaunched }: { onLaunched: (ns: string) => void }) {
  const [seedPath, setSeedPath] = useState("");
  const [pillar, setPillar] = useState("");
  const [topic, setTopic] = useState("");
  const [profile, setProfile] = useState<"short" | "long">("short");
  const [publishAt, setPublishAt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [convertMode, setConvertMode] = useState<"auto" | "convert" | "bypass">("auto");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!seedPath) {
      toast.error("Seed path is required");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { seedPath, profile, dryRun };
      if (pillar) body.pillar = pillar;
      if (topic) body.topic = topic;
      if (publishAt) body.publishAt = new Date(publishAt).toISOString();
      if (projectId) body.projectId = projectId;
      if (convertMode !== "auto") body.convert = convertMode === "convert";
      const r = await api.launchSeed(body);
      toast.success("Seed run launched", r.ns);
      onLaunched(r.ns);
    } catch (e) {
      toast.error("Launch failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Play className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Seed run from pre-written research</CardTitle>
        </div>
        <CardDescription>
          Feeds pre-written research (and optional script) into the pipeline. Skips the LLM research
          and script producers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>Seed file path *</Label>
          <Input
            value={seedPath}
            onChange={(e) => setSeedPath(e.target.value)}
            placeholder="/absolute/path/to/seed.json"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">Accepts .json, .txt, .md.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pillar (optional)">
            <Input
              value={pillar}
              onChange={(e) => setPillar(e.target.value)}
              placeholder="Psychology"
            />
          </Field>
          <Field label="Topic (optional)">
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Why your brain…"
            />
          </Field>
          <Field label="Profile">
            <Select value={profile} onValueChange={(v) => setProfile(v as "short" | "long")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="short">short</SelectItem>
                <SelectItem value="long">long</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Publish at (ISO 8601, optional)">
            <Input
              type="datetime-local"
              value={publishAt}
              onChange={(e) => setPublishAt(e.target.value)}
            />
          </Field>
          <Field label="Sheet row id (project-id, optional)">
            <Input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="row id"
            />
          </Field>
          <Field label="Mode">
            <Select
              value={convertMode}
              onValueChange={(v) => setConvertMode(v as "auto" | "convert" | "bypass")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">auto-detect</SelectItem>
                <SelectItem value="convert">force LLM convert</SelectItem>
                <SelectItem value="bypass">force structured bypass</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground/90">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="h-4 w-4 rounded border-input bg-background accent-primary"
          />
          Dry-run (validate only)
        </label>

        <Button onClick={onSubmit} disabled={busy}>
          {busy ? "Launching…" : "Launch seed run"}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </CardContent>
    </Card>
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
