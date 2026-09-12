import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Image as ImageIcon,
  KeyRound,
  ListChecks,
  Mic2,
  PlayCircle,
  Waves,
} from "lucide-react";
import { api, type RunSummary } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { formatRelativeTime } from "@/lib/utils";
import { useConfig } from "@/lib/config-context";

type ServiceHealth = { name: string; status: "ok" | "down" | "unknown"; hint?: string };

const SERVICE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "Orchestrator (langgraph)": Activity,
  "Image Provider": ImageIcon,
  TTS: Mic2,
  Transcriber: Waves,
};

export function Home() {
  const { ttsEnabled } = useConfig();
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const orch = (await api.health().then((h) => h.langgraph).catch(() => "down")) as
        | "ok"
        | "down";
      const probes: Promise<ServiceHealth>[] = [
        api.imageProvider.health().then((s) => ({ name: "Image Provider", status: s })),
        api.transcriber.health().then((s) => ({ name: "Transcriber", status: s })),
      ];
      if (ttsEnabled) {
        probes.push(api.tts.health().then((s) => ({ name: "TTS", status: s })));
      }
      const extra = await Promise.all(probes);
      if (!alive) return;
      setServices([
        { name: "Orchestrator (langgraph)", status: orch },
        ...extra,
      ]);
    };
    const loadRuns = async () => {
      try {
        const r = await api.listRuns();
        if (alive) setRecentRuns(r.slice(0, 5));
      } catch {
        // ignore
      } finally {
        if (alive) setLoading(false);
      }
    };
    tick();
    loadRuns();
    const t = setInterval(() => {
      tick();
      loadRuns();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ttsEnabled]);

  const allOk = services.length > 0 && services.every((s) => s.status === "ok");
  const anyDown = services.some((s) => s.status === "down");
  const activeCount = recentRuns.filter((r) => r.status === "running").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations dashboard"
        description="Real-time health and recent production activity for the Shorts pipeline."
        meta={
          <>
            {services.length > 0 && (
              allOk ? (
                <Badge variant="success">All systems online</Badge>
              ) : anyDown ? (
                <Badge variant="destructive">{services.filter((s) => s.status === "down").length} service(s) offline</Badge>
              ) : (
                <Badge variant="warning">Partial connectivity</Badge>
              )
            )}
            {activeCount > 0 && (
              <Badge variant="default" className="gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                {activeCount} run{activeCount === 1 ? "" : "s"} in progress
              </Badge>
            )}
          </>
        }
      />

      <div className="space-y-6 px-4 pb-8 sm:px-6">
        <section>
          <SectionHeader title="Service health" description="Live ping of the core services." />
          {services.length === 0 ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {services.map((s) => {
                const Icon = SERVICE_ICONS[s.name] ?? Activity;
                return (
                  <Card key={s.name} className="transition-colors hover:border-primary/30">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                          <Icon className="h-4 w-4" />
                        </div>
                        <CardTitle className="text-sm">{s.name}</CardTitle>
                      </div>
                      <StatusBadge status={s.status} />
                    </CardHeader>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <SectionHeader
              title="Recent runs"
              description="Latest production activity."
              action={
                <Button variant="ghost" size="sm" asChild>
                  <a href="#/runs">
                    View all <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                </Button>
              }
            />
            <Card>
              <CardContent className="p-0">
                {loading ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : recentRuns.length === 0 ? (
                  <EmptyState
                    icon={<ListChecks className="h-6 w-6" />}
                    title="No runs yet"
                    description="Launch a run from the Launch page or trigger the backlog."
                    action={
                      <Button asChild size="sm">
                        <a href="#/launch">
                          <PlayCircle className="h-4 w-4" /> Launch a run
                        </a>
                      </Button>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-border/60">
                    {recentRuns.map((r) => (
                      <li key={r.ns}>
                        <a
                          href={`#/run/${r.ns}`}
                          className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:bg-muted/30"
                        >
                          <span className="font-mono text-xs text-muted-foreground">
                            {formatRelativeTime(r.createdAt)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {r.topic ?? <span className="text-muted-foreground/60">untitled</span>}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="font-mono">{r.ns}</span>
                              {r.pillar && (
                                <>
                                  <span>·</span>
                                  <span>{r.pillar}</span>
                                </>
                              )}
                              {r.videoProfile && (
                                <>
                                  <span>·</span>
                                  <Badge variant="outline" className="h-4 px-1 text-[10px]">
                                    {r.videoProfile}
                                  </Badge>
                                </>
                              )}
                            </div>
                          </div>
                          <StatusBadge status={r.status} />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>

          <section>
            <SectionHeader title="Quick actions" description="Jump straight to common workflows." />
            <div className="grid grid-cols-1 gap-2">
              <QuickAction href="#/launch" icon={PlayCircle} title="Launch next" desc="Pick first pending row from backlog" />
              <QuickAction href="#/runs" icon={ListChecks} title="Browse runs" desc="Filter, sort, search run history" />
              <QuickAction href="#/image" icon={ImageIcon} title="Image Provider" desc="Generate scene images or videos" />
              {ttsEnabled && (
                <QuickAction href="#/tts" icon={Mic2} title="TTS" desc="Synthesize narration" />
              )}
              <QuickAction href="#/transcriber" icon={Waves} title="Transcriber" desc="Force-align audio to text" />
              <QuickAction href="#/auth" icon={KeyRound} title="Google Auth" desc="Set up OAuth refresh token" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
  desc,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
}) {
  return (
    <a
      href={href}
      className="group flex items-center gap-3 rounded-md border border-border/60 bg-card/50 px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-card"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{desc}</div>
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}
