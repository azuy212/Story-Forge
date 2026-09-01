import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

type Status = RunStatus | "ok" | "down" | "unknown";

const STATUS_MAP: Record<
  Status,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"]; dot: string }
> = {
  new: { label: "New", variant: "muted", dot: "bg-muted-foreground" },
  running: { label: "Running", variant: "default", dot: "bg-primary animate-pulse" },
  incomplete: { label: "Incomplete", variant: "warning", dot: "bg-warning" },
  failed: { label: "Failed", variant: "destructive", dot: "bg-destructive" },
  published: { label: "Published", variant: "success", dot: "bg-success" },
  aborted: { label: "Aborted", variant: "muted", dot: "bg-muted-foreground" },
  ok: { label: "Online", variant: "success", dot: "bg-success" },
  down: { label: "Offline", variant: "destructive", dot: "bg-destructive" },
  unknown: { label: "Unknown", variant: "muted", dot: "bg-muted-foreground" },
};

export function StatusBadge({
  status,
  className,
  withDot = true,
}: {
  status: Status;
  className?: string;
  withDot?: boolean;
}) {
  const config = STATUS_MAP[status] ?? STATUS_MAP.unknown;
  return (
    <Badge variant={config.variant} className={cn("font-medium", className)}>
      {withDot && <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />}
      <span className="capitalize">{config.label}</span>
    </Badge>
  );
}

export function HealthPill({ status }: { status: "ok" | "down" | "unknown" }) {
  return <StatusBadge status={status} />;
}
