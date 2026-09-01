import { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { Runs } from "./pages/Runs";
import { RunDetail } from "./pages/RunDetail";
import { Launch } from "./pages/Launch";
import { Auth } from "./pages/Auth";
import { ImageProvider } from "./pages/ImageProvider";
import { Tts } from "./pages/Tts";
import { Transcriber } from "./pages/Transcriber";
import { AppSidebar } from "@/components/shared/app-sidebar";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Route = { name: string; ns?: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return { name: "home" };
  const [name, ...rest] = h.split("/");
  return { name, ns: rest.join("/") };
}

const ROUTE_META: Record<string, { title: string; group: string }> = {
  home: { title: "Dashboard", group: "Overview" },
  runs: { title: "Runs", group: "Overview" },
  run: { title: "Run detail", group: "Overview" },
  launch: { title: "Launch", group: "Production" },
  image: { title: "Image Provider", group: "Services" },
  tts: { title: "Text to Speech", group: "Services" },
  transcriber: { title: "Transcriber", group: "Services" },
  auth: { title: "Google Auth", group: "Publishing" },
};

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setMobileNavOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function go(name: string, ns?: string) {
    window.location.hash = ns ? `/${name}/${ns}` : `/${name}`;
  }

  const meta = ROUTE_META[route.name] ?? { title: route.name, group: "" };

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppSidebar />

        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/60 bg-background/70 px-4 backdrop-blur-md sm:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Toggle navigation"
              onClick={() => setMobileNavOpen((s) => !s)}
            >
              {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </Button>
            <Breadcrumbs meta={meta} route={route} />
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
            </div>
          </header>

          <main className="flex-1 overflow-x-hidden">
            <MobileNav open={mobileNavOpen} />
            <div className={cn("mx-auto w-full", "max-w-7xl")}>
              {route.name === "home" && <Home />}
              {route.name === "runs" && <Runs onOpen={(ns) => go("run", ns)} />}
              {route.name === "run" && route.ns && (
                <RunDetail ns={route.ns} onBack={() => go("runs")} />
              )}
              {route.name === "launch" && <Launch onLaunched={(ns) => go("run", ns)} />}
              {route.name === "image" && <ImageProvider />}
              {route.name === "tts" && <Tts />}
              {route.name === "transcriber" && <Transcriber />}
              {route.name === "auth" && <Auth />}
            </div>
          </main>
        </div>

        <Toaster />
      </div>
    </TooltipProvider>
  );
}

function Breadcrumbs({
  meta,
  route,
}: {
  meta: { title: string; group: string };
  route: Route;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {meta.group && (
        <span className="hidden text-xs uppercase tracking-wider text-muted-foreground sm:inline">
          {meta.group}
        </span>
      )}
      {meta.group && <span className="hidden h-3 w-px bg-border sm:inline-block" />}
      <h2 className="truncate font-semibold tracking-tight">{meta.title}</h2>
      {route.ns && (
        <>
          <span className="hidden h-3 w-px bg-border sm:inline-block" />
          <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
            {route.ns}
          </span>
        </>
      )}
    </div>
  );
}

function MobileNav({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <div className="border-b border-border/60 bg-card px-4 py-3 md:hidden">
      <nav className="grid grid-cols-2 gap-1">
        {[
          { href: "#/home", label: "Dashboard" },
          { href: "#/runs", label: "Runs" },
          { href: "#/launch", label: "Launch" },
          { href: "#/image", label: "Image Provider" },
          { href: "#/tts", label: "TTS" },
          { href: "#/transcriber", label: "Transcriber" },
          { href: "#/auth", label: "Google Auth" },
        ].map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="rounded-md px-3 py-2 text-sm text-foreground hover:bg-accent"
          >
            {l.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
