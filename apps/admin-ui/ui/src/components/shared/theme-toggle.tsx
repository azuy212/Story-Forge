import { useEffect, useState } from "react";
import { useTheme } from "@/hooks/use-theme";
import { Button } from "@/components/ui/button";
import { Monitor, Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const cycle = () => {
    const order: Array<"dark" | "light" | "system"> = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const icon = !mounted ? (
    <Monitor className="h-4 w-4" />
  ) : theme === "system" ? (
    <Monitor className="h-4 w-4" />
  ) : resolvedTheme === "dark" ? (
    <Moon className="h-4 w-4" />
  ) : (
    <Sun className="h-4 w-4" />
  );

  const label = !mounted
    ? "Theme"
    : theme === "system"
      ? "Theme: system"
      : `Theme: ${resolvedTheme}`;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
    >
      {icon}
    </Button>
  );
}
