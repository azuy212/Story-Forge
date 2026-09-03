import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Coins,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  Filter,
  Hash,
  Layers3,
  Loader2,
  RefreshCw,
  Timer,
  Wallet,
  Zap,
} from "lucide-react";
import { useSheet } from "@/hooks/use-sheet";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { SearchInput } from "@/components/shared/search-input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { SheetProfile, SheetRecord } from "@/lib/sheet-types";
import { cn, formatUsd } from "@/lib/utils";

const STATUS_FILTERS = [
  "all",
  "planned",
  "scheduled",
  "published",
  "failed",
  "draft",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_STYLES: Record<
  string,
  { label: string; cls: string; dot: string }
> = {
  planned: {
    label: "Planned",
    cls: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  scheduled: {
    label: "Scheduled",
    cls: "bg-primary/15 text-primary",
    dot: "bg-primary",
  },
  published: {
    label: "Published",
    cls: "bg-success/15 text-success",
    dot: "bg-success",
  },
  failed: {
    label: "Failed",
    cls: "bg-destructive/15 text-destructive",
    dot: "bg-destructive",
  },
  draft: {
    label: "Draft",
    cls: "bg-warning/15 text-warning",
    dot: "bg-warning",
  },
  running: {
    label: "Running",
    cls: "bg-primary/15 text-primary",
    dot: "bg-primary animate-pulse",
  },
};

function statusBadge(status: string) {
  const key = status.trim().toLowerCase();
  const s = STATUS_STYLES[key] ?? {
    label: status || "Unknown",
    cls: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  };
  return (
    <Badge
      variant="secondary"
      className={cn("gap-1.5 font-medium capitalize", s.cls)}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </Badge>
  );
}

function formatNumber(n: number | null) {
  if (n === null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function SheetsView() {
  const sheet = useSheet();
  const [profile, setProfile] = useState<SheetProfile>("short");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const payload = sheet.payload(profile);

  const filtered = useMemo(() => {
    if (!payload) return [];
    const q = query.trim().toLowerCase();
    return payload.records.filter((r) => {
      if (statusFilter !== "all" && r.status.toLowerCase() !== statusFilter)
        return false;
      if (!q) return true;
      return (
        r.topic.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.videoId.toLowerCase().includes(q) ||
        r.youtubeId.toLowerCase().includes(q)
      );
    });
  }, [payload, statusFilter, query]);

  const totals = useMemo(() => {
    const acc = {
      planned: 0,
      scheduled: 0,
      published: 0,
      failed: 0,
      totalCost: 0,
      totalTokens: 0,
    };
    for (const r of payload?.records ?? []) {
      const k = r.status.toLowerCase();
      if (k in acc)
        acc[k as keyof typeof acc] = (acc[k as keyof typeof acc] as number) + 1;
      if (typeof r.llm.costUsd === "number") acc.totalCost += r.llm.costUsd;
      if (typeof r.llm.totalTokens === "number")
        acc.totalTokens += r.llm.totalTokens;
    }
    return acc;
  }, [payload]);

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Google Sheets"
        description="Backlog + published metadata from the YouTube planning sheet. Used by the Launch queue picker."
        meta={
          sheet.snapshot?.fetchedAt ? (
            <span className="text-xs text-muted-foreground">
              Fetched {new Date(sheet.snapshot.fetchedAt).toLocaleTimeString()}
              {sheet.snapshot.stale ? (
                <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-warning">
                  stale
                </span>
              ) : null}
            </span>
          ) : null
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void sheet.refresh()}
            disabled={sheet.loading}
          >
            {sheet.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      <div className="space-y-6 px-4 sm:px-6">
        {sheet.error ? (
          <ErrorBanner
            message={sheet.error}
            onRetry={() => void sheet.refresh()}
            retrying={sheet.loading}
          />
        ) : null}
        <Tabs
          value={profile}
          onValueChange={(v) => setProfile(v as SheetProfile)}
        >
          <TabsList>
            <TabsTrigger value="short">
              <Zap className="h-3.5 w-3.5" /> Short videos
            </TabsTrigger>
            <TabsTrigger value="long">
              <Layers3 className="h-3.5 w-3.5" /> Long videos
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <SummaryCards totals={totals} loading={sheet.loading && !payload} />

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center gap-3 space-y-0">
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                <CardTitle>
                  {payload?.sheetName ??
                    (profile === "short" ? "Sheet1" : "Long Videos")}
                </CardTitle>
              </div>
              <CardDescription>
                {filtered.length} of {payload?.records.length ?? 0} rows shown
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Search topic, title, video id…"
                className="w-56"
              />
              <StatusPicker value={statusFilter} onChange={setStatusFilter} />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {sheet.loading && !payload ? (
              <SheetTableSkeleton />
            ) : !payload ? (
              <div className="p-6">
                <EmptyState
                  icon={<FileSpreadsheet className="h-6 w-6" />}
                  title="No sheet data yet"
                  description="The orchestrator hasn't fetched the sheet. Check that GOOGLE_SHEETS_SPREADSHEET_ID is set in apps/orchestrator/.env."
                  action={
                    <Button
                      onClick={() => void sheet.refresh()}
                      disabled={sheet.loading}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  }
                />
              </div>
            ) : payload.error ? (
              <div className="p-6">
                <EmptyState
                  icon={<FileSpreadsheet className="h-6 w-6" />}
                  title={`Sheet "${payload.sheetName}" unavailable`}
                  description={payload.error}
                  action={
                    <Button
                      onClick={() => void sheet.refresh()}
                      disabled={sheet.loading}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  }
                />
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={<Filter className="h-6 w-6" />}
                  title="No matching rows"
                  description="Try clearing the filter or adjusting the search."
                />
              </div>
            ) : (
              <RecordsTable records={filtered} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryCards({
  totals,
  loading,
}: {
  totals: {
    planned: number;
    scheduled: number;
    published: number;
    failed: number;
    totalCost: number;
    totalTokens: number;
  };
  loading: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <SummaryCard
        label="Planned"
        value={totals.planned}
        icon={<CalendarClock className="h-3.5 w-3.5" />}
        loading={loading}
      />
      <SummaryCard
        label="Scheduled"
        value={totals.scheduled}
        icon={<Timer className="h-3.5 w-3.5" />}
        loading={loading}
      />
      <SummaryCard
        label="Published"
        value={totals.published}
        icon={<Eye className="h-3.5 w-3.5" />}
        loading={loading}
      />
      <SummaryCard
        label="Failed"
        value={totals.failed}
        icon={<Hash className="h-3.5 w-3.5" />}
        loading={loading}
        tone="destructive"
      />
      <SummaryCard
        label="Total tokens"
        value={formatNumber(totals.totalTokens)}
        icon={<Wallet className="h-3.5 w-3.5" />}
        loading={loading}
      />
      <SummaryCard
        label="Total cost"
        value={formatUsd(totals.totalCost)}
        icon={<Coins className="h-3.5 w-3.5" />}
        loading={loading}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  loading,
  tone,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  loading: boolean;
  tone?: "destructive";
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            tone === "destructive"
              ? "bg-destructive/10 text-destructive"
              : "bg-primary/10 text-primary",
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          {loading ? (
            <Skeleton className="mt-1 h-5 w-16" />
          ) : (
            <p className="truncate font-mono text-base font-semibold">
              {value}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusPicker({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as StatusFilter)}>
      <SelectTrigger className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_FILTERS.map((s) => (
          <SelectItem key={s} value={s} className="capitalize">
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RecordsTable({ records }: { records: SheetRecord[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Video ID</TableHead>
          <TableHead>Topic</TableHead>
          <TableHead className="hidden md:table-cell">Category</TableHead>
          <TableHead className="hidden lg:table-cell">Scheduled</TableHead>
          <TableHead className="hidden lg:table-cell">Published</TableHead>
          <TableHead className="hidden xl:table-cell">Duration</TableHead>
          <TableHead className="hidden md:table-cell">LLM</TableHead>
          <TableHead className="text-right">YouTube</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((r, idx) => (
          <TableRow key={`${r.videoId}-${idx}`}>
            <TableCell>{statusBadge(r.status)}</TableCell>
            <TableCell className="font-mono text-xs">
              {r.videoId || "—"}
            </TableCell>
            <TableCell className="max-w-md">
              <div className="line-clamp-2 text-sm">{r.topic || "—"}</div>
              {r.title ? (
                <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {r.title}
                </div>
              ) : null}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              {r.category ? (
                <Badge variant="outline" className="capitalize">
                  {r.category}
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="hidden font-mono text-xs lg:table-cell">
              {r.scheduledAtLocal || (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="hidden font-mono text-xs lg:table-cell">
              {r.publishedAtLocal || (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="hidden font-mono text-xs xl:table-cell">
              {r.duration || <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <LlmCell record={r} />
            </TableCell>
            <TableCell className="text-right">
              {r.youtubeUrl ? (
                <a
                  href={r.youtubeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-primary hover:border-primary/60"
                >
                  <ExternalLink className="h-3 w-3" />
                  {r.youtubeId || "open"}
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LlmCell({ record }: { record: SheetRecord }) {
  const { totalTokens, costUsd } = record.llm;
  if (totalTokens === null && costUsd === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="space-y-0.5 font-mono text-[11px] leading-tight">
      {totalTokens !== null ? (
        <div className="text-foreground/90">
          {formatNumber(totalTokens)} tokens
        </div>
      ) : null}
      {costUsd !== null ? (
        <div className="text-muted-foreground">{formatUsd(costUsd)}</div>
      ) : null}
    </div>
  );
}

function SheetTableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ErrorBanner({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Couldn&apos;t load sheet data</p>
        <p className="mt-0.5 break-words text-xs text-destructive/80">
          {message}
        </p>
        <p className="mt-1 text-xs text-destructive/70">
          If the server was just updated, do a hard refresh (Cmd/Ctrl+Shift+R)
          to clear the dev module cache.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        {retrying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Retry
      </Button>
    </div>
  );
}
