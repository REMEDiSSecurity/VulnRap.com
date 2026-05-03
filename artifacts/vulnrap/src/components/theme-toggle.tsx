import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle() {
  const { theme, cycleTheme } = useTheme();

  const icon =
    theme === "light" ? (
      <Sun className="w-4 h-4" />
    ) : theme === "dark" ? (
      <Moon className="w-4 h-4" />
    ) : (
      <Monitor className="w-4 h-4" />
    );

  const label =
    theme === "light"
      ? "Light theme (click for dark)"
      : theme === "dark"
        ? "Dark theme (click for system)"
        : "System theme (click for light)";

  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      className={cn(
        "p-2 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10",
        "transition-colors shrink-0 print:hidden",
      )}
    >
      {icon}
    </button>
  );
}
