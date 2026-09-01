import { useEffect, useState, type ComponentType } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Cog,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Mic2,
  Play,
  Waves,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

export type NavItem = {
  key: string;
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  group: "Overview" | "Production" | "Services" | "Publishing";
};

export const NAV_ITEMS: NavItem[] = [
  { key: "home", href: "#/home", label: "Dashboard", icon: LayoutDashboard, group: "Overview" },
  { key: "runs", href: "#/runs", label: "Runs", icon: ListChecks, group: "Overview" },
  { key: "launch", href: "#/launch", label: "Launch", icon: Play, group: "Production" },
  { key: "image", href: "#/image", label: "Image Provider", icon: ImageIcon, group: "Services" },
  { key: "tts", href: "#/tts", label: "TTS", icon: Mic2, group: "Services" },
  { key: "transcriber", href: "#/transcriber", label: "Waves", icon: Waves, group: "Services" },
  { key: "auth", href: "#/auth", label: "Google Auth", icon: KeyRound, group: "Publishing" },
];

const GROUPS: Array<NavItem["group"]> = ["Overview", "Production", "Services", "Publishing"];

const STORAGE_KEY = "admin-ui.sidebar.collapsed";

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [currentRoute, setCurrentRoute] = useState<string>("home");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      const h = window.location.hash.replace(/^#\/?/, "") || "home";
      const [name] = h.split("/");
      setCurrentRoute(name);
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        className={cn(
          "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex",
          "transition-[width] duration-200 ease-out",
          collapsed ? "w-[60px]" : "w-60",
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center border-b border-sidebar-border",
            collapsed ? "justify-center" : "px-4",
          )}
        >
          <a href="#/home" className="flex items-center gap-2 group" aria-label="Home">
            <BrandMark className="h-7 w-7 shrink-0" />
            {!collapsed && (
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold tracking-tight">StoryForge</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Shorts
                </span>
              </div>
            )}
          </a>
        </div>

        <nav className="flex-1 overflow-y-auto scroll-thin py-3">
          {GROUPS.map((group, gi) => (
            <div key={group} className={cn(gi > 0 && "mt-4")}>
              {!collapsed && (
                <div className="px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group}
                </div>
              )}
              <ul className="space-y-0.5 px-2">
                {NAV_ITEMS.filter((i) => i.group === group).map((item) => (
                  <li key={item.key}>
                    <SidebarLink
                      item={item}
                      active={currentRoute === item.key}
                      collapsed={collapsed}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <Separator className="bg-sidebar-border" />

        <div className={cn("p-2", collapsed ? "flex justify-center" : "")}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  collapsed && "h-9 w-9 justify-center",
                )}
              >
                {collapsed ? <ChevronRight className="h-4 w-4" /> : <Cog className="h-4 w-4 shrink-0" />}
                {!collapsed && <span>v0.1.0</span>}
                {!collapsed && <ChevronLeft className="ml-auto h-3.5 w-3.5" />}
              </button>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">Expand</TooltipContent>}
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const linkClasses = cn(
    "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
    collapsed && "h-9 w-9 justify-center px-0",
  );

  const inner = (
    <a href={item.href} className={linkClasses} aria-current={active ? "page" : undefined}>
      <item.icon
        className={cn(
          "h-4 w-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && active && <Activity className="ml-auto h-3.5 w-3.5 text-primary" />}
    </a>
  );

  if (!collapsed) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-md bg-gradient-to-br from-primary/30 to-primary/5 ring-1 ring-primary/30",
        className,
      )}
    >
      <svg
        viewBox="0 0 32 32"
        className="h-4 w-4 text-primary"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9 22V10l7 12V10" />
      </svg>
    </div>
  );
}
