import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "vulnrap:theme";

function readStoredTheme(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // ignore
  }
  return "system";
}

function systemPrefersLight(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "system") return systemPrefersLight() ? "light" : "dark";
  return choice;
}

export function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
  }
  root.style.colorScheme = resolved;
}

interface ThemeContextValue {
  theme: ThemeChoice;
  resolved: ResolvedTheme;
  setTheme: (t: ThemeChoice) => void;
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(() => readStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme()),
  );

  useEffect(() => {
    const r = resolveTheme(theme);
    setResolved(r);
    applyTheme(r);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Listen for OS-level changes when in "system" mode.
  useEffect(() => {
    if (
      theme !== "system" ||
      typeof window === "undefined" ||
      !window.matchMedia
    )
      return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      const r: ResolvedTheme = mq.matches ? "light" : "dark";
      setResolved(r);
      applyTheme(r);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemeChoice) => setThemeState(t), []);
  const cycleTheme = useCallback(() => {
    setThemeState((prev) =>
      prev === "system" ? "light" : prev === "light" ? "dark" : "system",
    );
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme, cycleTheme }),
    [theme, resolved, setTheme, cycleTheme],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback when used outside provider (e.g. tests).
    return {
      theme: "system",
      resolved: "dark",
      setTheme: () => {},
      cycleTheme: () => {},
    };
  }
  return ctx;
}
