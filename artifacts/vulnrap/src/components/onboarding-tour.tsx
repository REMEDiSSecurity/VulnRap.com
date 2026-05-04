import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { X, ArrowLeft, ArrowRight, CheckCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "vulnrap-onboarding-dismissed";

export const TOUR_STORAGE_KEYS = {
  home: STORAGE_KEY,
  check: "vulnrap-tour-check-dismissed",
  results: "vulnrap-tour-results-dismissed",
  compare: "vulnrap-tour-compare-dismissed",
} as const;

export function hasSeenPageTour(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function resetAllTours() {
  try {
    Object.values(TOUR_STORAGE_KEYS).forEach((k) =>
      localStorage.removeItem(k),
    );
  } catch {}
}
const SAMPLE_TEXT = `Title: Reflected XSS in /search query parameter

Affected: example-app v2.4.1 (commit 9af30c1, file src/routes/search.ts:42)
CWE: CWE-79 (Cross-site Scripting)

Steps to reproduce:
1. curl 'https://app.example.com/search?q=<script>alert(1)</script>'
2. Response renders the unescaped <script> tag in the results header.

Impact: Attacker-controlled JS executes in the victim's session context.
Fix: HTML-escape the q parameter before interpolating it into the template.`;

export interface TourStep {
  /** data-testid (or any querySelector) of the element to spotlight. */
  target: string;
  title: string;
  body: string;
  /** Optional preferred placement; falls back to "bottom" with viewport flip. */
  placement?: "top" | "bottom";
}

const DEFAULT_STEPS: TourStep[] = [
  {
    target: '[data-testid="input-rawtext"]',
    title: "1. Paste a sample report",
    body: "Drop any vulnerability report text here. We've pre-filled an example you can use right away — feel free to replace it with your own.",
    placement: "bottom",
  },
  {
    target: '[data-testid="button-submit"]',
    title: "2. Click Analyze Report",
    body: "Hit this button to submit. Your report is auto-redacted, fingerprinted, and scored — usually in under a few seconds.",
    placement: "top",
  },
  {
    target: '[data-testid="section-methodology"]',
    title: "3. Read the score",
    body: "Once analysis finishes, you'll get a 0–100 validity score plus engine-by-engine breakdowns. This section explains exactly what we measure.",
    placement: "top",
  },
  {
    target: '[data-testid="section-methodology-origin"]',
    title: "4. Explore the diagnostics",
    body: "Every score links to per-claim verification, duplicate matches, and signal evidence. Dig into the diagnostics panel on any results page to see why we scored your report the way we did.",
    placement: "top",
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function hasSeenOnboardingTour(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function resetOnboardingTour() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

interface OnboardingTourProps {
  steps?: TourStep[];
  storageKey?: string;
  /** Called after dismissal/finish so the host can unmount. */
  onClose: () => void;
  /** When true, paste the sample text into the textarea on step 1. */
  prefillSample?: (text: string) => void;
}

export function OnboardingTour({
  steps = DEFAULT_STEPS,
  storageKey = STORAGE_KEY,
  onClose,
  prefillSample,
}: OnboardingTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipSize, setTooltipSize] = useState<{ w: number; h: number }>({
    w: 320,
    h: 180,
  });
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const step = steps[stepIndex];

  const dismiss = useCallback(
    (permanent: boolean) => {
      if (permanent) {
        try {
          localStorage.setItem(storageKey, "1");
        } catch {}
      }
      onClose();
    },
    [onClose, storageKey],
  );

  // Compute target rect with scroll & resize re-measurement.
  useLayoutEffect(() => {
    if (!step) return;
    const update = () => {
      const el = document.querySelector(step.target);
      if (!el) {
        setTargetRect(null);
        return;
      }
      // Bring into view if off-screen.
      const r = el.getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight - 60) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setTargetRect(getRect(el));
    };
    update();
    const t = setTimeout(update, 350); // After scroll settles.
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [step, stepIndex]);

  // Track tooltip size for placement.
  useLayoutEffect(() => {
    if (!tooltipRef.current) return;
    const r = tooltipRef.current.getBoundingClientRect();
    setTooltipSize({ w: r.width, h: r.height });
  }, [stepIndex, targetRect]);

  // Keyboard handling.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss(true);
      } else if (e.key === "ArrowRight") {
        setStepIndex((i) => Math.min(i + 1, steps.length - 1));
      } else if (e.key === "ArrowLeft") {
        setStepIndex((i) => Math.max(i - 1, 0));
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss, steps.length]);

  // Focus close button on mount for keyboard a11y.
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // On entering step 1, optionally prefill the textarea sample.
  useEffect(() => {
    if (stepIndex === 0 && prefillSample) {
      prefillSample(SAMPLE_TEXT);
    }
  }, [stepIndex, prefillSample]);

  const tooltipPos = useMemo(() => {
    if (!targetRect) {
      return {
        top: Math.max(16, window.innerHeight / 2 - tooltipSize.h / 2),
        left: Math.max(16, window.innerWidth / 2 - tooltipSize.w / 2),
        arrow: "none" as const,
      };
    }
    const margin = 14;
    const preferTop = step?.placement === "top";
    const spaceBelow =
      window.innerHeight - (targetRect.top + targetRect.height);
    const spaceAbove = targetRect.top;
    const placeBelow = preferTop
      ? spaceAbove < tooltipSize.h + margin + 16
      : spaceBelow >= tooltipSize.h + margin + 16;
    let top = placeBelow
      ? targetRect.top + targetRect.height + margin
      : targetRect.top - tooltipSize.h - margin;
    let left = targetRect.left + targetRect.width / 2 - tooltipSize.w / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tooltipSize.w - 12));
    top = Math.max(12, Math.min(top, window.innerHeight - tooltipSize.h - 12));
    return {
      top,
      left,
      arrow: placeBelow ? ("up" as const) : ("down" as const),
    };
  }, [targetRect, tooltipSize, step]);

  if (!step) return null;

  const isLast = stepIndex === steps.length - 1;
  const isFirst = stepIndex === 0;

  // Spotlight cutout via 4 overlay rects (no SVG/clip-path needed).
  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-tour-title"
      className="fixed inset-0"
      style={{ zIndex: 10000 }}
    >
      {/* Backdrop with spotlight */}
      {targetRect ? (
        <>
          {/* top */}
          <div
            className="absolute bg-black/70 transition-all"
            style={{
              top: 0,
              left: 0,
              right: 0,
              height: Math.max(0, targetRect.top - 6),
            }}
            onClick={() => dismiss(true)}
          />
          {/* bottom */}
          <div
            className="absolute bg-black/70 transition-all"
            style={{
              top: targetRect.top + targetRect.height + 6,
              left: 0,
              right: 0,
              bottom: 0,
            }}
            onClick={() => dismiss(true)}
          />
          {/* left */}
          <div
            className="absolute bg-black/70 transition-all"
            style={{
              top: Math.max(0, targetRect.top - 6),
              left: 0,
              width: Math.max(0, targetRect.left - 6),
              height: targetRect.height + 12,
            }}
            onClick={() => dismiss(true)}
          />
          {/* right */}
          <div
            className="absolute bg-black/70 transition-all"
            style={{
              top: Math.max(0, targetRect.top - 6),
              left: targetRect.left + targetRect.width + 6,
              right: 0,
              height: targetRect.height + 12,
            }}
            onClick={() => dismiss(true)}
          />
          {/* spotlight ring */}
          <div
            className="absolute rounded-lg pointer-events-none transition-all"
            style={{
              top: targetRect.top - 6,
              left: targetRect.left - 6,
              width: targetRect.width + 12,
              height: targetRect.height + 12,
              boxShadow:
                "0 0 0 2px hsl(var(--primary)), 0 0 0 6px hsl(var(--primary) / 0.25), 0 0 24px hsl(var(--primary) / 0.4)",
            }}
          />
        </>
      ) : (
        <div
          className="absolute inset-0 bg-black/70"
          onClick={() => dismiss(true)}
        />
      )}

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className={cn(
          "absolute w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-primary/40 bg-popover shadow-2xl shadow-black/70 p-4 space-y-3",
        )}
        style={{
          top: tooltipPos.top,
          left: tooltipPos.left,
          backgroundColor: "hsl(var(--popover))",
        }}
        data-testid="onboarding-tour-tooltip"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-primary/15 text-primary shrink-0">
              <Sparkles className="w-3.5 h-3.5" />
            </span>
            <h3
              id="onboarding-tour-title"
              className="font-semibold text-sm text-foreground truncate"
            >
              {step.title}
            </h3>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={() => dismiss(true)}
            aria-label="Dismiss tour"
            className="shrink-0 text-muted-foreground hover:text-primary transition-colors p-1 -m-1 rounded"
            data-testid="onboarding-tour-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {step.body}
        </p>

        {/* Step dots */}
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === stepIndex
                  ? "w-5 bg-primary"
                  : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
          <span className="ml-auto text-[10px] font-mono text-muted-foreground/70">
            {stepIndex + 1} / {steps.length}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() => dismiss(true)}
            className="text-[11px] text-muted-foreground/70 hover:text-primary transition-colors"
            data-testid="onboarding-tour-dont-show"
          >
            Don't show again
          </button>
          <div className="flex items-center gap-1.5">
            {!isFirst && (
              <button
                type="button"
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                data-testid="onboarding-tour-back"
              >
                <ArrowLeft className="w-3 h-3" />
                Back
              </button>
            )}
            {!isLast ? (
              <button
                type="button"
                onClick={() =>
                  setStepIndex((i) => Math.min(steps.length - 1, i + 1))
                }
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors glow-button"
                data-testid="onboarding-tour-next"
              >
                Next
                <ArrowRight className="w-3 h-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => dismiss(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors glow-button"
                data-testid="onboarding-tour-finish"
              >
                <CheckCircle className="w-3 h-3" />
                Got it
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(overlay, document.body);
}
