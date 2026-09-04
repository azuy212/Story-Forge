import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Save, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type State = "idle" | "starting" | "awaiting-auth" | "ready-to-save" | "saving" | "saved";

export function Auth() {
  const [state, setState] = useState<State>("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const flowId = useRef<string | null>(null);

  // Once the authUrl is shown, poll the server until the script has produced
  // a refresh token (or exited). Auto-fills the input so the user doesn't
  // have to copy from a terminal.
  useEffect(() => {
    if (state !== "awaiting-auth") return;
    const id = flowId.current;
    if (!id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.oauthStatus(id);
        if (cancelled) return;
        if (s.refreshToken && !token) {
          setToken(s.refreshToken);
          setState("ready-to-save");
          toast.success("Refresh token received");
        }
        if (s.status === "failed" && !s.refreshToken) {
          toast.error(
            "OAuth script exited without a refresh token",
            `code=${s.code ?? "?"}`,
          );
          setState("idle");
          return;
        }
        if (s.status === "complete" && !s.refreshToken) {
          // Script ended cleanly but no token — leave UI in awaiting-auth
          // so the user can still paste manually if they got it elsewhere.
          return;
        }
        if (!s.refreshToken) setTimeout(tick, 1000);
      } catch {
        if (!cancelled) setTimeout(tick, 1500);
      }
    };
    setTimeout(tick, 1000);
    return () => {
      cancelled = true;
    };
  }, [state, token]);

  async function start() {
    setState("starting");
    setSaved(null);
    setToken("");
    try {
      const r = await api.oauthStart();
      flowId.current = r.id;
      setAuthUrl(r.authUrl);
      setState("awaiting-auth");
    } catch (e) {
      toast.error("Could not start OAuth", (e as Error).message);
      setState("idle");
    }
  }

  async function save() {
    if (!token) {
      toast.warning("Paste the refresh token first");
      return;
    }
    setState("saving");
    try {
      const r = await api.oauthSave(token);
      setSaved(r.backup);
      setState("saved");
      toast.success("Token saved");
    } catch (e) {
      toast.error("Save failed", (e as Error).message);
      setState("ready-to-save");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Google OAuth"
        description="One-time setup that captures a refresh token and saves it to the orchestrator .env."
      />
      <div className="space-y-6 px-4 pb-10 sm:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Authorization flow</CardTitle>
            </div>
            <CardDescription>
              Tokens are stored locally in <span className="font-mono text-foreground/80">apps/orchestrator/.env</span>{" "}
              with a <span className="font-mono text-foreground/80">.bak</span> backup. Never committed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Step
              index={1}
              active={state === "idle"}
              done={state !== "idle" && state !== "starting"}
              title="Start the OAuth helper"
              description="Spawns the server-side helper, which prints the auth URL."
            >
              <Button
                onClick={start}
                disabled={state === "starting" || state === "awaiting-auth"}
              >
                {state === "starting" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {state === "starting" ? "Starting…" : "Start OAuth flow"}
              </Button>
            </Step>

            {authUrl && (
              <Step
                index={2}
                active={state === "awaiting-auth"}
                title="Authorize in the browser"
                description="Open the link, complete consent, then capture the refresh token printed in the server terminal."
              >
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all rounded-md border border-border/60 bg-background/40 p-3 text-xs text-primary hover:underline"
                >
                  {authUrl}
                </a>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex"
                >
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3 w-3" /> Open in new tab
                  </Button>
                </a>
              </Step>
            )}

            {state !== "idle" && state !== "starting" && (
              <Step
                index={3}
                active={state === "ready-to-save" || state === "saving"}
                done={state === "saved"}
                title="Paste the refresh token"
                description="The terminal will print the refresh token after consent. Paste it here."
              >
                <div className="space-y-1.5">
                  <Label>Refresh token</Label>
                  <Input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="1//0e…"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground">
                    Treat this like a password. Only the server reads it; the UI never displays it after save.
                  </p>
                </div>
                <Button
                  onClick={save}
                  disabled={state === "saving" || !token}
                  className="gap-1.5"
                >
                  {state === "saving" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save to .env
                </Button>
              </Step>
            )}

            {saved && (
              <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  Saved. Backup created at{" "}
                  <span className="font-mono">{saved}</span>.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Step({
  index,
  title,
  description,
  active = false,
  done = false,
  children,
}: {
  index: number;
  title: string;
  description: string;
  active?: boolean;
  done?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-border/60 p-4 transition-colors",
        active && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="mb-3 flex items-start gap-3">
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            done
              ? "bg-success/20 text-success"
              : active
                ? "bg-primary/20 text-primary"
                : "bg-muted text-muted-foreground",
          )}
        >
          {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index}
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children && <div className="ml-9 space-y-3">{children}</div>}
    </div>
  );
}
