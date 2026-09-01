import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  MoreHorizontal,
  Trash2,
  Eye,
  RefreshCw,
} from "lucide-react";
import { api, type RunSummary, type RunStatus } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { PageHeader } from "@/components/shared/page-header";
import { SearchInput } from "@/components/shared/search-input";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { formatRelativeTime, truncate } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

const STATUSES: RunStatus[] = ["new", "running", "incomplete", "failed", "published", "aborted"];

type SortKey = "ns" | "topic" | "status" | "createdAt" | "videoProfile" | "runSource";
type SortDir = "asc" | "desc";

export function Runs({ onOpen }: { onOpen: (ns: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<RunStatus | "all">("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listRuns()
      .then((r) => {
        if (alive) setRuns(r);
        if (alive) setError(null);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [refreshTick]);

  useEffect(() => {
    const t = setInterval(() => setRefreshTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (profileFilter !== "all" && (r.videoProfile ?? "short") !== profileFilter) return false;
      if (sourceFilter !== "all" && r.runSource !== sourceFilter) return false;
      if (q) {
        const hay = `${r.ns} ${r.topic ?? ""} ${r.pillar ?? ""} ${r.projectId ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = (a[sortKey] ?? "") as string;
      const bv = (b[sortKey] ?? "") as string;
      if (sortKey === "createdAt") {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return (at - bt) * dir;
      }
      return av.localeCompare(bv) * dir;
    });
  }, [runs, statusFilter, profileFilter, sourceFilter, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "createdAt" ? "desc" : "asc");
    }
  }

  async function onDelete(ns: string) {
    try {
      await api.deleteRun(ns);
      toast.success(`Run ${ns} deleted`);
      setRefreshTick((n) => n + 1);
    } catch (e) {
      toast.error("Delete failed", (e as Error).message);
    } finally {
      setConfirmDelete(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Runs"
        description={`${runs.length} run${runs.length === 1 ? "" : "s"} on disk`}
        actions={
          <Button variant="outline" size="sm" onClick={() => setRefreshTick((n) => n + 1)}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      <div className="space-y-3 px-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search ns, topic, pillar, project id…"
            className="min-w-60 flex-1"
          />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as RunStatus | "all")}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={profileFilter} onValueChange={setProfileFilter}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="All profiles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All profiles</SelectItem>
              <SelectItem value="short">short</SelectItem>
              <SelectItem value="long">long</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="backlog">backlog</SelectItem>
              <SelectItem value="seed">seed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && runs.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No runs match"
            description={
              runs.length === 0
                ? "Launch a run from the Launch page or trigger the backlog."
                : "Try adjusting filters or clearing the search."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead
                    label="Namespace"
                    active={sortKey === "ns"}
                    dir={sortDir}
                    onClick={() => toggleSort("ns")}
                  />
                  <SortableHead
                    label="Topic"
                    active={sortKey === "topic"}
                    dir={sortDir}
                    onClick={() => toggleSort("topic")}
                  />
                  <TableHead>Pillar</TableHead>
                  <SortableHead
                    label="Profile"
                    active={sortKey === "videoProfile"}
                    dir={sortDir}
                    onClick={() => toggleSort("videoProfile")}
                  />
                  <SortableHead
                    label="Source"
                    active={sortKey === "runSource"}
                    dir={sortDir}
                    onClick={() => toggleSort("runSource")}
                  />
                  <SortableHead
                    label="Status"
                    active={sortKey === "status"}
                    dir={sortDir}
                    onClick={() => toggleSort("status")}
                  />
                  <SortableHead
                    label="Created"
                    active={sortKey === "createdAt"}
                    dir={sortDir}
                    onClick={() => toggleSort("createdAt")}
                  />
                  <TableHead className="w-12 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.ns} className="group">
                    <TableCell>
                      <button
                        onClick={() => onOpen(r.ns)}
                        className="font-mono text-xs text-primary hover:underline focus-visible:outline-none"
                        title={r.ns}
                      >
                        {truncate(r.ns, 28)}
                      </button>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <span className="block truncate" title={r.topic ?? ""}>
                        {r.topic ?? <span className="text-muted-foreground/60">—</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.pillar ? (
                        <Badge variant="outline">{r.pillar}</Badge>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.videoProfile ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="muted">{r.runSource}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.createdAt ? formatRelativeTime(r.createdAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-7 w-7 opacity-60 group-hover:opacity-100"
                            aria-label="Row actions"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => onOpen(r.ns)}>
                            <Eye className="h-4 w-4" /> Open
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setConfirmDelete(r.ns)}
                          >
                            <Trash2 className="h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete run?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <span className="font-mono text-foreground">{confirmDelete}</span>{" "}
              and all its assets. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && onDelete(confirmDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SortableHead({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <TableHead>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
