import { useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyButtonProps = {
  value: string;
  label?: string;
  className?: string;
};

export function CopyButton({ value, label = "Copy", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={label}
      className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", className)}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

export function MetaRow({
  label,
  value,
  mono = false,
  copyable = false,
  className,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  copyable?: boolean;
  className?: string;
}) {
  const isEmpty = value === null || value === undefined || value === "";
  return (
    <div className={cn("flex items-start justify-between gap-3 py-1.5", className)}>
      <span className="shrink-0 text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 items-center justify-end gap-1">
        <span
          className={cn(
            "text-sm text-foreground",
            mono && "font-mono",
            isEmpty && "text-muted-foreground/60",
            "text-right break-words",
          )}
          title={typeof value === "string" ? value : undefined}
        >
          {isEmpty ? "—" : value}
        </span>
        {copyable && !isEmpty && typeof value === "string" && <CopyButton value={value} />}
      </div>
    </div>
  );
}
