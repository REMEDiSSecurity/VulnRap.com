import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCalibrationToken } from "@workspace/api-client-react";

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

function isValidTheme(v: unknown): v is ThemeChoice {
  return v === "system" || v === "light" || v === "dark";
}

function buildApiUrl(path: string): string {
  const base = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
  return `${base.replace(/\/$/, "")}/api${path}`;
}

async function fetchServerTheme(): Promise<ThemeChoice | null> {
  const token = getCalibrationToken();
  if (!token) return null;
  try {
    const headers: Record<string, string> = {
      "x-calibration-token": token,
    };
    const res = await fetch(buildApiUrl("/preferences/theme"), { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { theme?: string };
    if (isValidTheme(data.theme)) return data.theme;
  } catch {
    // ignore
  }
  return null;
}

function saveServerTheme(choice: ThemeChoice): void {
  const token = getCalibrationToken();
  if (!token) return;
  fetch(buildApiUrl("/preferences/theme"), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-calibration-token": token,
    },
    body: JSON.stringify({ theme: choice }),
  }).catch(() => {
    // fire-and-forget
  });
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
  const serverFetched = useRef(false);

  useEffect(() => {
    if (serverFetched.current) return;
    serverFetched.current = true;
    fetchServerTheme().then((serverTheme) => {
      if (serverTheme !== null) {
        setThemeState(serverTheme);
      }
    });
  }, []);

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

  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    saveServerTheme(t);
  }, []);
  const cycleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next =
        prev === "system" ? "light" : prev === "light" ? "dark" : "system";
      saveServerTheme(next);
      return next;
    });
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
    return {
      theme: "system",
      resolved: "dark",
      setTheme: () => {},
      cycleTheme: () => {},
    };
  }
  return ctx;
}
