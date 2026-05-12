import {
  lazy,
  Suspense,
  useState,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  UploadCloud,
  Shield,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  Search,
  Zap,
  ClipboardPaste,
  Info,
  X,
  Link2,
  AlertTriangle,
  Mail,
  BrainCircuit,
  ShieldOff,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  ExternalLink,
  ChevronDown,
} from "lucide-react";
import {
  useSubmitReport,
  SubmitReportBodyContentMode,
} from "@workspace/api-client-react";
import { LogoBeams } from "@/components/laser-effects";
import { CrawlingBugs } from "@/components/crawling-bugs";
import { DriftFlagsBanner } from "@/components/drift-flags-banner";
import { ReportSubmitCooldownBanner } from "@/components/report-submit-cooldown-banner";
import { useReportSubmitCooldown } from "@/lib/report-submit-cooldown";
import { addHistoryEntry } from "@/lib/history";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { cn, anonymizeId } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { AnalysisStepper } from "@/components/analysis-stepper";
import { QualityPreviewSidebar } from "@/components/quality-preview-sidebar";
import logoSrc from "@/assets/logo.png";

import {
  OnboardingTour,
  hasSeenOnboardingTour,
  SAMPLE_TEXT as ONBOARDING_SAMPLE_TEXT,
} from "@/components/onboarding-tour";
import { t } from "@/lib/i18n";
import {
  MAX_TEXT_LENGTH,
  validateFile,
  type InputMode,
  type UploadStage,
} from "./utils";
import { Explainer } from "./explainer";
import { VideoSection } from "./video-section";
import { AutoRedactionCard } from "./auto-redaction-card";
import { SectionHashingCard } from "./section-hashing-card";
import { SlopDetectionCard } from "./slop-detection-card";
import { VisitorCounter } from "./visitor-counter";
import { TrustBadges } from "./trust-badges";

// Below-the-fold sections — lazy loaded so they don't bloat the initial
// home-page JS bundle. The user has to scroll past several full-height
// sections (and usually expand at least one feature card) before any of
// these mount, so deferring them is a clean win for time-to-interactive.
const TransparencySection = lazy(() => import("./transparency-section"));
const DevelopersAndAgentsSection = lazy(
  () => import("./developers-and-agents-section"),
);
const RecentReportsFeed = lazy(() => import("./recent-reports-feed"));

interface CollapsibleSectionProps {
  id: string;
  testId?: string;
  eyebrow: string;
  title: ReactNode;
  icon: ReactNode;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

function CollapsibleSection({
  id,
  testId,
  eyebrow,
  title,
  icon,
  subtitle,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      id={id}
      data-testid={testId}
      className="glass-card rounded-xl overflow-hidden scroll-mt-20"
      data-scroll-fade
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full p-3 sm:p-4 flex items-start justify-between gap-3 text-left cursor-pointer group/collapsible ring-1 ring-transparent hover:ring-primary/30 focus-visible:ring-primary/50 focus-visible:outline-none transition-all duration-200"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              {icon}
              {title}
            </h2>
            <span className="eyebrow-label">{eyebrow}</span>
          </div>
          {subtitle && (
            <p className="text-[11px] text-muted-foreground leading-snug mt-1">
              {subtitle}
            </p>
          )}
        </div>
        <ChevronDown
          className={cn(
            "w-4 h-4 mt-0.5 text-primary/60 group-hover/collapsible:text-primary transition-all duration-200 flex-shrink-0",
            open && "rotate-180 text-primary",
          )}
        />
      </button>
      {open && (
        <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
          {children}
        </div>
      )}
    </div>
  );
}

function LazySectionFallback() {
  // Reserve roughly the same vertical space as a real section so that the
  // page doesn't jump as each lazy chunk resolves.
  return (
    <div
      className="glass-card rounded-xl p-6 min-h-[180px] flex items-center justify-center"
      aria-hidden
    >
      <div className="w-5 h-5 border-2 border-primary/60 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<SubmitReportBodyContentMode>(
    SubmitReportBodyContentMode.full,
  );
  const [showInFeed, setShowInFeed] = useState(true);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [skipLlm, setSkipLlm] = useState(false);
  const [skipRedaction, setSkipRedaction] = useState(false);
  const logoRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = logoRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      document.documentElement.style.setProperty("--beam-origin-y", `${cy}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--beam-origin-y");
    };
  }, []);

  // Scroll-triggered fade-in for major glass-card sections.
  // Elements tagged with `data-scroll-fade` are observed; when they intersect
  // the viewport they get `is-visible` and the CSS transition runs.
  // We only add the `scroll-fade-in` class via JS so that users on browsers
  // without IntersectionObserver (or with JS off entirely) still see content.
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) return;
    // Use a MutationObserver so lazy-loaded sections still get observed
    // when they mount after the initial pass.
    const seen = new WeakSet<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" },
    );
    const observe = (root: ParentNode) => {
      const els = Array.from(
        root.querySelectorAll<HTMLElement>("[data-scroll-fade]"),
      );
      els.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        el.classList.add("scroll-fade-in");
        observer.observe(el);
      });
    };
    observe(document);
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) observe(n as Element);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      observer.disconnect();
    };
  }, []);

  // Task #417 — surface the shared `/api/reports` rate limiter as a
  // friendly countdown banner above the submit card instead of letting
  // the mutation's onError bubble a raw "HTTP 429" toast. The hook
  // itself only re-renders while the cooldown is active, so the home
  // page pays nothing on the steady-state happy path.
  const reportSubmitCooldown = useReportSubmitCooldown();

  const submitMutation = useSubmitReport({
    mutation: {
      onMutate: () => {
        setStage("uploading");
        setTimeout(
          () => setStage((prev) => (prev === "uploading" ? "analyzing" : prev)),
          800,
        );
      },
      onSuccess: (data) => {
        setStage("done");
        if (data.deleteToken) {
          try {
            const tokens = JSON.parse(
              sessionStorage.getItem("vulnrap_delete_tokens") || "{}",
            );
            tokens[data.id] = data.deleteToken;
            sessionStorage.setItem(
              "vulnrap_delete_tokens",
              JSON.stringify(tokens),
            );
          } catch {}
        }
        addHistoryEntry({
          id: data.id,
          reportCode: anonymizeId(data.id),
          slopScore: data.slopScore,
          slopTier: data.slopTier,
          matchCount: data.similarityMatches?.length || 0,
          contentMode: data.contentMode,
          fileName: data.fileName || null,
          timestamp: new Date().toISOString(),
          type: "submit",
        });
        toast({
          title: t("home.analysisCompleteToast"),
          description: "Navigating to results...",
        });
        setTimeout(() => navigate(`/results/${data.id}`), 600);
      },
      onError: (err: unknown) => {
        setStage("error");
        let message = "An error occurred during analysis.";
        if (err && typeof err === "object") {
          const e = err as Record<string, unknown>;
          if (
            "data" in e &&
            e.data &&
            typeof e.data === "object" &&
            "error" in (e.data as Record<string, unknown>)
          ) {
            message = String((e.data as Record<string, unknown>).error);
          } else if ("message" in e && typeof e.message === "string") {
            message = e.message;
          } else if ("error" in e) {
            message = String(e.error);
          }
        }
        toast({
          title: t("home.uploadFailedToast"),
          description: message,
          variant: "destructive",
        });
      },
    },
  });

  const handleFileSelect = (selectedFile: File) => {
    const error = validateFile(selectedFile);
    if (error) {
      setFile(null);
      setFileError(error);
      toast({
        title: "Invalid file",
        description: error,
        variant: "destructive",
      });
      return;
    }
    setFile(selectedFile);
    setFileError(null);
    setStage("idle");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleSubmit = () => {
    const feedVal = mode === "full" && showInFeed ? "true" : "false";
    if (inputMode === "file") {
      if (!file) {
        toast({
          title: "No file selected",
          description: "Please select a report file first.",
          variant: "destructive",
        });
        return;
      }
      const error = validateFile(file);
      if (error) {
        setFileError(error);
        toast({
          title: "Invalid file",
          description: error,
          variant: "destructive",
        });
        return;
      }
      submitMutation.mutate({
        data: {
          file,
          contentMode: mode,
          showInFeed: feedVal,
          skipLlm: skipLlm ? "true" : "false",
          skipRedaction: skipRedaction ? "true" : "false",
        },
      });
    } else if (inputMode === "link") {
      const trimmedUrl = reportUrl.trim();
      if (!trimmedUrl) {
        toast({
          title: "No URL entered",
          description: "Please enter a link to a report.",
          variant: "destructive",
        });
        return;
      }
      try {
        new URL(trimmedUrl);
      } catch {
        toast({
          title: "Invalid URL",
          description: "Please enter a valid HTTPS URL.",
          variant: "destructive",
        });
        return;
      }
      submitMutation.mutate({
        data: {
          reportUrl: trimmedUrl,
          contentMode: mode,
          showInFeed: feedVal,
          skipLlm: skipLlm ? "true" : "false",
          skipRedaction: skipRedaction ? "true" : "false",
        },
      });
    } else {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) {
        toast({
          title: "No text entered",
          description: "Please paste your report text first.",
          variant: "destructive",
        });
        return;
      }
      if (trimmed === ONBOARDING_SAMPLE_TEXT.trim()) {
        toast({
          title: "That's the demo sample",
          description:
            "We block submission of the onboarding example so demo text never lands in our database. Replace it with your own report and try again.",
          variant: "destructive",
        });
        return;
      }
      if (new Blob([trimmed]).size > MAX_TEXT_LENGTH) {
        toast({
          title: "Text too large",
          description: "Pasted text exceeds the 5MB limit.",
          variant: "destructive",
        });
        return;
      }
      submitMutation.mutate({
        data: {
          rawText: trimmed,
          contentMode: mode,
          showInFeed: feedVal,
          skipLlm: skipLlm ? "true" : "false",
          skipRedaction: skipRedaction ? "true" : "false",
        },
      });
    }
  };

  const hasContent =
    inputMode === "file"
      ? !!file
      : inputMode === "link"
        ? reportUrl.trim().length > 0
        : rawText.trim().length > 0;
  const isProcessing =
    stage === "uploading" || stage === "analyzing" || stage === "done";

  const getButtonContent = () => {
    switch (stage) {
      case "uploading":
        return (
          <>
            <Loader2 className="w-5 h-5 animate-spin" /> {t("home.uploading")}
          </>
        );
      case "analyzing":
        return (
          <>
            <Loader2 className="w-5 h-5 animate-spin" /> {t("home.analyzing")}
          </>
        );
      case "done":
        return (
          <>
            <CheckCircle className="w-5 h-5" /> {t("home.complete")}
          </>
        );
      case "error":
        return (
          <>
            <XCircle className="w-5 h-5" /> {t("home.failedTryAgain")}
          </>
        );
      default:
        return t("home.analyzeReport");
    }
  };

  // First-run onboarding tour. Skipped if the user has already dismissed it,
  // unless they explicitly re-trigger it via the footer "Restart tour" link
  // (which sets ?tour=1) or removes the localStorage flag.
  const [showTour, setShowTour] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const forced = params.get("tour") === "1";
    if (forced || !hasSeenOnboardingTour()) {
      // Slight delay so the page has settled and target rects are stable.
      const t = setTimeout(() => setShowTour(true), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);

  const [mirrorBannerDismissed, setMirrorBannerDismissed] = useState(() => {
    try {
      return sessionStorage.getItem("vulnrap-mirror-dismissed") === "1";
    } catch {
      return false;
    }
  });

  const dismissMirrorBanner = () => {
    setMirrorBannerDismissed(true);
    try {
      sessionStorage.setItem("vulnrap-mirror-dismissed", "1");
    } catch {}
  };

  useEffect(() => {
    if (mirrorBannerDismissed) return;
    const timer = setTimeout(dismissMirrorBanner, 5000);
    return () => clearTimeout(timer);
  }, [mirrorBannerDismissed]);

  return (
    <div className="max-w-4xl mx-auto space-y-5 sm:space-y-6">
      <CrawlingBugs />
      <VideoSection />
      <DriftFlagsBanner />
      {!mirrorBannerDismissed && (
        <div className="relative mt-2 sm:mt-4 mx-auto max-w-3xl rounded-lg border border-primary/20 bg-primary/5 backdrop-blur-sm px-3 sm:px-4 py-3 flex items-start gap-2.5 sm:gap-3 text-sm">
          <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 text-muted-foreground leading-relaxed text-xs sm:text-sm">
            <span className="text-primary font-semibold">CyMeme.com</span> is
            the official alternate mirror for{" "}
            <a
              href="https://vulnrap.com"
              className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors font-medium"
            >
              VulnRap.com
            </a>
            . Many enterprise networks block newly registered domains — if you
            can't reach VulnRap.com directly, you're in the right place.
          </div>
          <button
            onClick={dismissMirrorBanner}
            className="shrink-0 text-muted-foreground/60 hover:text-primary transition-colors p-0.5 rounded"
            aria-label="Dismiss notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="space-y-2 sm:space-y-3 text-center pt-1 sm:pt-2">
        <div className="relative flex justify-center">
          <div className="relative">
            <LogoBeams />
            <div className="absolute inset-0 rounded-xl bg-primary/10 blur-3xl scale-150 z-0" />
            <img
              ref={logoRef}
              src={logoSrc}
              alt="VulnRap"
              className="relative z-10 w-14 h-14 sm:w-16 sm:h-16 md:w-20 md:h-20 rounded-xl logo-glow gradient-border"
            />
          </div>
        </div>
        <h1
          className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight text-primary uppercase glow-text"
          data-testid="text-heading"
        >
          {t("home.heading")}
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground max-w-2xl mx-auto leading-snug px-2">
          {t("home.tagline")}
        </p>
        <TrustBadges />
      </div>

      <div
        id="section-workflow"
        className="glass-card rounded-xl p-3 sm:p-4 space-y-3 scroll-mt-20"
        data-scroll-fade
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            How it works
          </h2>
          <span className="eyebrow-label">Section 01 · Workflow</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg glass-card feature-card">
            <div className="p-1.5 rounded-md icon-glow-cyan flex-shrink-0 flex items-center justify-center">
              <UploadCloud className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-mono font-bold text-cyan-400/80">
                  01
                </span>
                <h3 className="font-medium text-xs sm:text-sm truncate">Submit</h3>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Paste, upload, or link a report.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg glass-card feature-card">
            <div className="p-1.5 rounded-md icon-glow-green flex-shrink-0 flex items-center justify-center">
              <ShieldOff className="w-4 h-4 text-green-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-mono font-bold text-green-400/80">
                  02
                </span>
                <h3 className="font-medium text-xs sm:text-sm truncate">Redact</h3>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                PII and secrets scrubbed before storage.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg glass-card feature-card">
            <div className="p-1.5 rounded-md icon-glow-violet flex-shrink-0 flex items-center justify-center">
              <BrainCircuit className="w-4 h-4 text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-mono font-bold text-violet-400/80">
                  03
                </span>
                <h3 className="font-medium text-xs sm:text-sm truncate">Analyze</h3>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Verify claims, check for duplicates, score validity.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg glass-card feature-card">
            <div className="p-1.5 rounded-md icon-glow-amber flex-shrink-0 flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-mono font-bold text-amber-400/80">
                  04
                </span>
                <h3 className="font-medium text-xs sm:text-sm truncate">Results</h3>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Score, matches, and triage in seconds.
              </p>
            </div>
          </div>
        </div>
      </div>

      <ReportSubmitCooldownBanner state={reportSubmitCooldown} />

      <Card className="glass-card-accent rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-primary" />
            {t("home.submitReport")}
            <Explainer text="Submit a vulnerability report for analysis. Upload a file or paste your report text directly. We'll verify factual claims, check it against previously submitted reports, and score the likelihood the issue is real and reproducible." />
          </CardTitle>
          <CardDescription>{t("home.submitReportDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 sm:space-y-8">
          <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-3 sm:px-4 py-2.5 sm:py-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-yellow-500">Heads up:</strong> We try to
            auto-redact PII, secrets, credentials, and company names before
            storing or comparing your report. If your report contains sensitive
            details, pre-sanitize those sections yourself before uploading.
          </div>
          <div className="flex rounded-xl overflow-hidden glass-card">
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all",
                inputMode === "file"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground",
              )}
              onClick={() => {
                setInputMode("file");
                setStage("idle");
              }}
              data-testid="tab-file"
            >
              <UploadCloud className="w-4 h-4 shrink-0" />
              <span className="hidden xs:inline">Upload</span> File
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all border-l border-border/30",
                inputMode === "text"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground",
              )}
              onClick={() => {
                setInputMode("text");
                setStage("idle");
              }}
              data-testid="tab-text"
            >
              <ClipboardPaste className="w-4 h-4 shrink-0" />
              Paste
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all border-l border-border/30",
                inputMode === "link"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground",
              )}
              onClick={() => {
                setInputMode("link");
                setStage("idle");
              }}
              data-testid="tab-link"
            >
              <Link2 className="w-4 h-4 shrink-0" />
              Link
            </button>
          </div>

          {inputMode === "file" ? (
            <div
              data-testid="dropzone"
              className={cn(
                "border-2 border-dashed rounded-xl p-3 min-h-[7rem] flex flex-col items-center justify-center gap-2 transition-all cursor-pointer",
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/20 hover:border-primary/40",
                file && !fileError ? "border-primary/40 bg-primary/5" : "",
                fileError ? "border-destructive bg-destructive/5" : "",
              )}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".txt,.md"
                onChange={handleFileChange}
                data-testid="input-file"
              />
              {fileError ? (
                <>
                  <XCircle className="w-6 h-6 text-destructive shrink-0" />
                  <div className="text-center">
                    <p className="font-medium text-destructive text-sm">
                      {fileError}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Click to select a different file
                    </p>
                  </div>
                </>
              ) : file ? (
                <>
                  <div className="flex items-center gap-2 text-center">
                    <FileText className="w-5 h-5 text-primary shrink-0" />
                    <div className="text-left">
                      <p
                        className="font-medium text-sm leading-tight"
                        data-testid="text-filename"
                      >
                        {file.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                      setFileError(null);
                      setStage("idle");
                    }}
                    className="h-7 text-xs"
                    data-testid="button-clear"
                  >
                    {t("home.clearSelection")}
                  </Button>
                </>
              ) : (
                <>
                  <UploadCloud className="w-6 h-6 text-muted-foreground shrink-0" />
                  <div className="text-center">
                    <p className="font-medium text-sm">
                      {t("home.dragDropHere")}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("home.dragDropHelp")}
                    </p>
                  </div>
                </>
              )}
            </div>
          ) : inputMode === "text" ? (
            <div className="space-y-2">
              <textarea
                data-testid="input-rawtext"
                className="w-full h-28 min-h-[7rem] rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
                placeholder="Paste your vulnerability report text here...&#10;&#10;This field accepts plain text only. All content is treated as text -- no HTML, markdown rendering, or code execution."
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setStage("idle");
                }}
                spellCheck={false}
                autoComplete="off"
              />
              <div className="flex justify-between items-center text-xs text-muted-foreground">
                <span>
                  {rawText.length > 0
                    ? `${rawText.length.toLocaleString()} characters`
                    : "No text entered"}
                </span>
                {rawText.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                    onClick={() => {
                      setRawText("");
                      setStage("idle");
                    }}
                    data-testid="button-clear-text"
                  >
                    {t("home.clearText")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <input
                  type="url"
                  data-testid="input-url"
                  className="w-full rounded-xl glass-card px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
                  placeholder="https://github.com/user/repo/blob/main/report.md"
                  value={reportUrl}
                  onChange={(e) => {
                    setReportUrl(e.target.value);
                    setStage("idle");
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
                {reportUrl.trim().length > 0 && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => {
                        setReportUrl("");
                        setStage("idle");
                      }}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <div className="rounded-lg bg-muted/30 px-4 py-3 text-xs text-muted-foreground leading-relaxed space-y-1.5">
                <p className="font-medium text-foreground/80">
                  Supported sources:
                </p>
                <p>
                  GitHub (blob URLs auto-converted to raw), GitHub Gists,
                  GitLab, Pastebin, dpaste, hastebin, paste.debian.net
                </p>
                <p>
                  HTTPS only — max 5MB. The URL must point to plain text, not an
                  HTML page.
                </p>
              </div>
            </div>
          )}

          <div className="border border-border/40 rounded-lg overflow-hidden bg-background/30">
            <button
              type="button"
              onClick={() => setOptionsExpanded(!optionsExpanded)}
              aria-expanded={optionsExpanded}
              className="w-full flex items-center justify-between gap-3 p-3 sm:p-4 text-left hover:bg-muted/20 transition-colors group/options"
              data-testid="toggle-submit-options"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Shield className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm font-medium">
                  Sharing &amp; analysis options
                </span>
                <span className="hidden sm:inline text-[11px] text-muted-foreground/80 truncate">
                  ·{" "}
                  {mode === "full"
                    ? showInFeed
                      ? "shared with community + listed in feed"
                      : "shared with community"
                    : "private (similarity only)"}
                  {(skipLlm || skipRedaction) && " · custom"}
                </span>
              </div>
              <ChevronDown
                className={cn(
                  "w-4 h-4 text-muted-foreground transition-transform shrink-0",
                  optionsExpanded && "rotate-180 text-primary",
                )}
              />
            </button>
            {optionsExpanded && (
              <div className="px-3 sm:px-4 pb-4 pt-1 space-y-6 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="space-y-4">
            <h3 className="font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              How should we handle your report?
            </h3>
            <RadioGroup
              value={mode}
              onValueChange={(v) => {
                setMode(v as SubmitReportBodyContentMode);
                if (v === "similarity_only") setShowInFeed(false);
              }}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              <div
                className={cn(
                  "border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors",
                  mode === "full"
                    ? "border-primary bg-primary/5"
                    : "border-border",
                )}
                onClick={() => setMode(SubmitReportBodyContentMode.full)}
              >
                <div className="flex items-start gap-3">
                  <RadioGroupItem
                    value={SubmitReportBodyContentMode.full}
                    id="full"
                    className="mt-1"
                  />
                  <div className="space-y-1">
                    <Label htmlFor="full" className="font-bold cursor-pointer">
                      Share with the community
                    </Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      We understand that the only way this works is with trust —
                      and data in the form of reports that can be compared. Your
                      report (with PII and secrets auto-removed) is saved and
                      helps the entire community detect duplicates and AI slop.
                      If you'd be willing to gift us some training data —
                      rejected AI slop, or examples of what you look for in a
                      valid report — the community as a whole benefits. Please{" "}
                      <a
                        href="mailto:remedisllc@gmail.com"
                        className="text-primary hover:underline"
                      >
                        reach out
                      </a>{" "}
                      if you can!
                    </p>
                  </div>
                </div>
                {mode === "full" && (
                  <label className="flex items-center gap-2 mt-3 ml-7 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={showInFeed}
                      onChange={(e) => setShowInFeed(e.target.checked)}
                      className="rounded border-border accent-primary w-4 h-4"
                    />
                    <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                      Show in the recent reports feed on this site
                    </span>
                  </label>
                )}
              </div>
              <div
                className={cn(
                  "border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors",
                  mode === "similarity_only"
                    ? "border-primary bg-primary/5"
                    : "border-border",
                )}
                onClick={() => {
                  setMode(SubmitReportBodyContentMode.similarity_only);
                  setShowInFeed(false);
                }}
              >
                <div className="flex items-start gap-3">
                  <RadioGroupItem
                    value={SubmitReportBodyContentMode.similarity_only}
                    id="similarity_only"
                    className="mt-1"
                  />
                  <div className="space-y-1">
                    <Label
                      htmlFor="similarity_only"
                      className="font-bold cursor-pointer"
                    >
                      Keep it private
                    </Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      We only store a mathematical fingerprint of your report --
                      no text is saved at all. Use this for sensitive zero-days
                      you want to keep confidential.
                    </p>
                  </div>
                </div>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-3">
            <h3 className="font-medium flex items-center gap-2 text-sm">
              <Zap className="w-4 h-4 text-primary" />
              Analysis Options
              <Explainer text="Control what happens during analysis. By default, both AI analysis and PII redaction are enabled." />
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label
                className={`flex items-start gap-3 p-3 rounded-lg border border-border transition-colors ${skipRedaction ? "opacity-60 cursor-not-allowed" : "hover:border-primary/30 cursor-pointer"} group`}
              >
                <input
                  type="checkbox"
                  checked={skipLlm}
                  onChange={(e) => setSkipLlm(e.target.checked)}
                  disabled={skipRedaction}
                  className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                  data-testid="toggle-skip-llm"
                />
                <div className="space-y-1">
                  <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <BrainCircuit className="w-3.5 h-3.5" />
                    Skip AI analysis
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {skipRedaction
                      ? "Locked on — AI analysis is disabled when PII redaction is off."
                      : "Disable LLM calls — analysis uses only local heuristic and statistical scoring. No report data is sent to any external AI provider."}
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer group">
                <input
                  type="checkbox"
                  checked={skipRedaction}
                  onChange={(e) => {
                    setSkipRedaction(e.target.checked);
                    if (e.target.checked) setSkipLlm(true);
                  }}
                  className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                  data-testid="toggle-skip-redaction"
                />
                <div className="space-y-1">
                  <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <ShieldOff className="w-3.5 h-3.5" />
                    Disable PII redaction
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Skip PII auto-redaction. Report text will not be sanitized
                    for personally identifiable information. AI analysis is
                    automatically disabled when redaction is off to prevent
                    unredacted data from reaching external services.
                  </p>
                </div>
              </label>
            </div>
            {skipRedaction && (
              <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 px-3 py-2 flex items-start gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-500 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-orange-300 leading-relaxed">
                  <strong>Warning:</strong> Only use for known slop submissions
                  or local deployments. PII, secrets, and company names in your
                  report will <strong>not</strong> be removed before storage or
                  comparison.
                </p>
              </div>
            )}
          </div>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3 px-4 sm:px-6">
          <Button
            className="w-full h-11 sm:h-12 text-base sm:text-lg font-bold gap-2 glow-button"
            onClick={handleSubmit}
            disabled={
              !hasContent ||
              isProcessing ||
              !!fileError ||
              reportSubmitCooldown.active
            }
            data-testid="button-submit"
          >
            {getButtonContent()}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Free and anonymous. No account required.{" "}
            <Link to="/privacy" className="text-primary hover:underline">
              Read our privacy policy
            </Link>{" "}
            to learn exactly what we store.
          </p>
        </CardFooter>
      </Card>

      {inputMode === "text" && rawText.trim().length > 0 && (
        <QualityPreviewSidebar text={rawText} />
      )}

      <AnalysisStepper
        isActive={isProcessing && stage !== "done"}
        mode="submit"
        className="my-4"
      />

      <div id="section-engines" className="space-y-2 scroll-mt-20">
        <div className="flex items-center justify-between gap-2 flex-wrap px-1">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            Three engines, one verdict
          </h2>
          <span className="eyebrow-label">Section 02 · How we score it</span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug max-w-3xl px-1">
          Tap any card to see what we redact, how duplicates are detected, and how the score is composed.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
          <AutoRedactionCard />
          <SectionHashingCard />
          <SlopDetectionCard />
        </div>
      </div>


      <CollapsibleSection
        id="section-methodology"
        testId="section-methodology"
        eyebrow="Section 03 · Methodology"
        title="What happens around the engines"
        icon={<BrainCircuit className="w-5 h-5 text-primary" />}
        subtitle={
          <>
            The three engines and their sub-weights live in the{" "}
            <span className="text-foreground font-semibold">
              Validity Scoring
            </span>{" "}
            card up top. Tap to expand: live verification sources, evidence
            multipliers, and how we landed on these weights.
          </>
        }
      >
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md icon-glow-green flex-shrink-0">
              <ShieldCheck className="w-3.5 h-3.5 text-green-400" />
            </span>
            How we check the claims (validation sources)
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Engine scoring tells us if the report <em>looks</em> real. Active
            verification tells us if it <em>is</em> real. Anything we can
            verify, we go check live:
          </p>
          <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-foreground">CVE database (NVD):</strong>{" "}
                Every CVE the report cites is looked up live. We check the ID
                actually exists, that the description and CWE match what the
                report claims, and we flag anything that's hallucinated or
                misattributed.
              </span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-foreground">
                  GitHub repositories &amp; commits:
                </strong>{" "}
                If the report references a repo, file path, line number, or
                commit SHA, we fetch it to verify the file exists, the line is
                real, and the commit hash resolves. Fake-looking paths like{" "}
                <code className="font-mono text-[10px] bg-muted px-1 rounded">
                  src/utils/helper.js:42
                </code>{" "}
                with nothing else specific are a classic slop signal.
              </span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-foreground">
                  Package → repository mapping:
                </strong>{" "}
                When a report names an npm/PyPI/Maven package, we map it to its
                real source repo and verify the affected version actually exists
                in the registry's release history.
              </span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-foreground">
                  Section fingerprints (duplicate detection):
                </strong>{" "}
                Every paragraph is hashed and compared against every other
                report we've ever seen. If your "novel" finding is
                paragraph-for-paragraph identical to a report we processed three
                months ago, we'll tell you.
              </span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span>
                <strong className="text-foreground">Verification tags:</strong>{" "}
                Each verified claim is tagged{" "}
                <em className="text-foreground">referenced</em> (the report
                itself pointed to a real, checkable source) or{" "}
                <em className="text-foreground">fallback</em> (we had to go find
                a likely source ourselves). Referenced verifications carry more
                weight than fallbacks.
              </span>
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md icon-glow-amber flex-shrink-0">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
            </span>
            Evidence multipliers — what bumps the score up or down
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            On top of the engine vote, certain pieces of evidence get an
            outsized effect because they were the most reliable signal in our
            calibration data:
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg bg-green-500/5 border border-green-500/20 p-3 space-y-2">
              <h4 className="text-xs font-bold text-green-400 flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5" />
                Pulls the score toward "looks real"
              </h4>
              <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                {[
                  "A CVE ID that resolves and matches the described bug",
                  "A real commit SHA on the affected repo",
                  "Real file paths with real line numbers",
                  "A working command-line PoC with actual output",
                  "Tight CWE/PoC alignment",
                ].map((item) => (
                  <li key={item} className="flex gap-1.5 items-start">
                    <CheckCircle className="w-3 h-3 text-green-400/80 mt-0.5 flex-shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3 space-y-2">
              <h4 className="text-xs font-bold text-red-400 flex items-center gap-1.5">
                <TrendingDown className="w-3.5 h-3.5" />
                Pulls the score toward "likely slop"
              </h4>
              <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                {[
                  "Hallucinated CVE IDs or non-existent paths",
                  'Generic "an attacker could…" speculation with no PoC',
                  "Title CWE doesn't match the evidence shown",
                  "Section-for-section duplicate of an earlier report",
                  "Test/example certificates being claimed as live findings",
                ].map((item) => (
                  <li key={item} className="flex gap-1.5 items-start">
                    <XCircle className="w-3 h-3 text-red-400/80 mt-0.5 flex-shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/80 leading-relaxed pt-1">
            Writing a real finding that <em>reads</em> like slop? See our{" "}
            <a
              href="/docs/llm-rewrite-prompt.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
              data-testid="link-llm-rewrite-prompt"
            >
              LLM rewrite prompt + guardrails
            </a>{" "}
            — restructure your report without inventing facts. (And here's why
            faking detail still won't slip past the engines.)
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="section-methodology-origin"
        testId="section-methodology-origin"
        eyebrow="Section 04 · Origin Story"
        title="How we landed on this methodology — and how to make it better"
        icon={<Search className="w-5 h-5 text-primary" />}
      >
        <div className="space-y-3 text-xs sm:text-sm text-muted-foreground leading-relaxed">
          <div className="pull-quote space-y-3">
            <p>
              These weights and signals didn't come out of thin air. We worked
              through a large corpus of real-world vulnerability submissions — a
              mix of well-known confirmed reports, public bug-bounty
              disclosures, and the increasingly familiar wave of LLM-generated
              slop that PSIRT inboxes have been flooded with over the last two
              years. For each report we recorded what humans ultimately decided
              about it (real, duplicate, or noise), then tuned the engine
              weights and the evidence multipliers until the model's verdicts
              lined up with the human verdicts.
            </p>
            <p>
              That's how we ended up at the{" "}
              <span className="text-foreground font-semibold">
                60% / 35% / 5%
              </span>{" "}
              split (refined from an earlier 55% / 40% / 5% as the
              substance-vs-coherence calibration matured through Sprint 12):
              substance-of-PoC and CWE-coherence were the two signals that
              consistently separated real submissions from generated ones, while
              pure linguistic "this sounds like an LLM wrote it" cues turned out
              to be much noisier than they look in isolation. The blog post on
              the field test walks through specific examples from that round of
              calibration if you want to see the receipts.
            </p>
          </div>
          <div className="rounded-xl bg-primary/5 border border-primary/20 p-4 space-y-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary" />
              Got a better idea? We genuinely want to hear it.
            </h3>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
              We don't think this is the final word on triage scoring. If you've
              got a signal we're missing, a verification source we should be
              hitting, an evidence pattern that fooled us, or a corpus we should
              be calibrating against — please reach out. The more analyst
              experience we can fold into the weights, the better this gets for
              everyone drowning in incoming reports.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href="mailto:remedisllc@gmail.com?subject=VulnRap%20methodology%20feedback"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors glow-button"
                data-testid="link-methodology-feedback"
              >
                <Mail className="w-3.5 h-3.5" />
                Email the team
              </a>
              <a
                href="https://github.com/REMEDiSSecurity/VulnRap.Com/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:border-primary/40 text-xs font-medium text-foreground transition-colors"
                data-testid="link-methodology-issues"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open an issue on GitHub
              </a>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      <Suspense fallback={<LazySectionFallback />}>
        <TransparencySection />
      </Suspense>

      <Suspense fallback={<LazySectionFallback />}>
        <DevelopersAndAgentsSection />
      </Suspense>

      <Suspense fallback={<LazySectionFallback />}>
        <RecentReportsFeed />
      </Suspense>

      <VisitorCounter />

      {showTour && (
        <OnboardingTour
          onClose={() => setShowTour(false)}
          prefillSample={(text) => {
            // Switch to the paste tab and seed the textarea so step 1's
            // spotlight has something to point at — but never overwrite
            // text the user has already typed.
            setInputMode("text");
            setRawText((current) =>
              current.trim().length === 0 ? text : current,
            );
          }}
        />
      )}
    </div>
  );
}
