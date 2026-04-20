import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Activity, Search, Code, BookOpen, MessageSquare, Menu, X, Github,
  Clock, GitCompare, UploadCloud, BarChart3, Database, Eye, FileText,
  ChevronDown, FileEdit, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import logoSrc from "@/assets/logo.png";
import { LaserEffects } from "@/components/laser-effects";
import { CursorBugs } from "@/components/cursor-bugs";
import { CURRENT_VERSION, RELEASE_DATE } from "@/pages/changelog";

function feedbackMailto(page: string) {
  const subject = encodeURIComponent("VulnRap Feedback");
  const body = encodeURIComponent(
    `Hi VulnRap team,\n\nI wanted to share some feedback:\n\n[Your feedback here]\n\n---\nPage: ${page}`
  );
  return `mailto:remedisllc@gmail.com?subject=${subject}&body=${body}`;
}

interface NavLeafItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  description?: string;
}

interface NavGroup {
  label: string;
  icon: React.ReactNode;
  // The nav root used for "active" highlighting (any of these prefixes match)
  matchPrefixes: string[];
  items: NavLeafItem[];
}

type NavEntry = NavLeafItem | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return (entry as NavGroup).items !== undefined;
}

const NAV: NavEntry[] = [
  {
    label: "Analyze",
    icon: <Sparkles className="w-3.5 h-3.5" />,
    matchPrefixes: ["/", "/check", "/batch", "/compare"],
    items: [
      { to: "/", label: "Submit", icon: <FileEdit className="w-4 h-4" />, description: "Paste or upload a single report for scoring." },
      { to: "/check", label: "Check", icon: <Search className="w-4 h-4" />, description: "Look up a previously submitted report by ID." },
      { to: "/batch", label: "Batch", icon: <UploadCloud className="w-4 h-4" />, description: "Upload many reports at once for bulk scoring." },
      { to: "/compare", label: "Compare", icon: <GitCompare className="w-4 h-4" />, description: "Diff two reports side-by-side." },
    ],
  },
  { to: "/history", label: "History", icon: <Clock className="w-3.5 h-3.5" /> },
  { to: "/reports", label: "Reports", icon: <Database className="w-3.5 h-3.5" /> },
  {
    label: "Insights",
    icon: <BarChart3 className="w-3.5 h-3.5" />,
    matchPrefixes: ["/stats", "/feedback-analytics", "/transparency"],
    items: [
      { to: "/stats", label: "Stats", icon: <Activity className="w-4 h-4" />, description: "Aggregate scoring stats and engine health." },
      { to: "/feedback-analytics", label: "Feedback", icon: <BarChart3 className="w-4 h-4" />, description: "What analysts are telling us about results." },
      { to: "/transparency", label: "Impact", icon: <Eye className="w-4 h-4" />, description: "Public-good metrics and transparency report." },
    ],
  },
  {
    label: "Docs",
    icon: <BookOpen className="w-3.5 h-3.5" />,
    matchPrefixes: ["/developers", "/blog", "/changelog"],
    items: [
      { to: "/developers", label: "API", icon: <Code className="w-4 h-4" />, description: "REST endpoints, schemas, and examples." },
      { to: "/blog", label: "Blog", icon: <FileText className="w-4 h-4" />, description: "Field tests, methodology, and post-mortems." },
      { to: "/changelog", label: "Changelog", icon: <BookOpen className="w-4 h-4" />, description: "Per-release notes and version history." },
    ],
  },
];

function isPathActive(pathname: string, target: string): boolean {
  return target === "/" ? pathname === "/" : pathname.startsWith(target);
}

function isGroupActive(pathname: string, group: NavGroup): boolean {
  return group.items.some(item => isPathActive(pathname, item.to));
}

interface NavDropdownProps {
  group: NavGroup;
  pathname: string;
}

function NavDropdown({ group, pathname }: NavDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const active = isGroupActive(pathname, group);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Close on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "text-sm font-medium transition-all px-3 py-1.5 rounded-md flex items-center gap-1.5 whitespace-nowrap",
          active
            ? "text-primary bg-primary/10 glow-text-sm"
            : "text-muted-foreground hover:text-primary hover:bg-primary/5"
        )}
      >
        {group.icon}
        {group.label}
        <ChevronDown
          className={cn("w-3 h-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1 w-72 rounded-lg border border-primary/30 bg-popover shadow-2xl shadow-black/60 overflow-hidden"
          style={{ zIndex: 80, backgroundColor: "hsl(var(--popover))" }}
        >
          <div className="py-1">
            {group.items.map(item => {
              const itemActive = isPathActive(pathname, item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-start gap-3 px-3 py-2.5 transition-colors",
                    itemActive
                      ? "text-primary bg-primary/10"
                      : "text-foreground/90 hover:text-primary hover:bg-primary/5"
                  )}
                >
                  <span className={cn("mt-0.5 shrink-0", itemActive ? "text-primary" : "text-muted-foreground")}>
                    {item.icon}
                  </span>
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium leading-tight">{item.label}</span>
                    {item.description && (
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileMenuOpen]);

  return (
    <div className="laser-content-layer min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground overflow-x-hidden">
      <div className="cyber-grid" aria-hidden="true" />
      <LaserEffects />
      <CursorBugs />
      <header className="nav-glass sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0 group" onClick={() => setMobileMenuOpen(false)}>
            <img src={logoSrc} alt="VulnRap" className="w-7 h-7 rounded-sm transition-transform group-hover:scale-110" />
            <span className="font-bold text-base tracking-tight uppercase text-primary glow-text-sm transition-all group-hover:glow-text whitespace-nowrap">VulnRap</span>
          </Link>

          <nav className="hidden lg:flex items-center gap-0.5">
            {NAV.map((entry) => {
              if (isGroup(entry)) {
                return <NavDropdown key={entry.label} group={entry} pathname={pathname} />;
              }
              const active = isPathActive(pathname, entry.to);
              return (
                <Link
                  key={entry.to}
                  to={entry.to}
                  className={cn(
                    "text-sm font-medium transition-all px-3 py-1.5 rounded-md flex items-center gap-1.5 whitespace-nowrap",
                    active
                      ? "text-primary bg-primary/10 glow-text-sm"
                      : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                  )}
                >
                  {entry.icon}
                  {entry.label}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            className="lg:hidden p-2 -mr-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 top-14"
          style={{ zIndex: 9999 }}
        >
          <div
            className="absolute inset-0"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.7)" }}
            onClick={() => setMobileMenuOpen(false)}
          />
          <nav
            className="relative border-b border-primary/15 max-h-[calc(100vh-3.5rem)] overflow-y-auto"
            style={{ backgroundColor: "hsl(220, 30%, 6%)" }}
          >
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-1">
              {NAV.map((entry) => {
                if (isGroup(entry)) {
                  const active = isGroupActive(pathname, entry);
                  return (
                    <div key={entry.label} className="flex flex-col gap-0.5 pt-1">
                      <div className={cn(
                        "flex items-center gap-2 px-4 pt-2 pb-1 text-xs uppercase tracking-wide font-semibold",
                        active ? "text-primary" : "text-muted-foreground"
                      )}>
                        <span className="w-4 flex items-center justify-center">{entry.icon}</span>
                        {entry.label}
                      </div>
                      {entry.items.map(item => {
                        const itemActive = isPathActive(pathname, item.to);
                        return (
                          <Link
                            key={item.to}
                            to={item.to}
                            onClick={() => setMobileMenuOpen(false)}
                            className={cn(
                              "flex items-center gap-3 px-7 py-3 rounded-lg text-base font-medium transition-all",
                              itemActive
                                ? "text-primary bg-primary/15 glow-text-sm"
                                : "text-white/85 hover:text-primary hover:bg-primary/5"
                            )}
                          >
                            <span className="w-4 flex items-center justify-center">{item.icon}</span>
                            {item.label}
                          </Link>
                        );
                      })}
                    </div>
                  );
                }
                const active = isPathActive(pathname, entry.to);
                return (
                  <Link
                    key={entry.to}
                    to={entry.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3.5 rounded-lg text-base font-semibold transition-all",
                      active
                        ? "text-primary bg-primary/15 glow-text-sm"
                        : "text-white/90 hover:text-primary hover:bg-primary/5"
                    )}
                  >
                    <span className="w-5 flex items-center justify-center">{entry.icon}</span>
                    {entry.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>
      )}

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {children}
      </main>

      <footer className="footer-gradient py-8 sm:py-10 mt-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col items-center gap-4 text-xs text-muted-foreground">
          <div className="flex flex-col items-center gap-4 w-full">
            <div className="flex items-center gap-2.5 text-center">
              <img src={logoSrc} alt="" className="w-5 h-5 rounded-sm opacity-50 shrink-0" />
              <span className="text-muted-foreground/70 leading-relaxed">VulnRap // Free & Anonymous Vulnerability Report Validation — made by and for frustrated PSIRTlings</span>
            </div>
            <div className="flex flex-wrap gap-x-4 sm:gap-x-5 gap-y-1.5 justify-center">
              <Link to="/use-cases" className="hover:text-primary transition-colors">Use Cases</Link>
              <Link to="/developers" className="hover:text-primary transition-colors">API Docs</Link>
              <Link to="/blog" className="hover:text-primary transition-colors">Blog</Link>
              <Link to="/security" className="hover:text-primary transition-colors">Security</Link>
              <Link to="/privacy" className="hover:text-primary transition-colors">Privacy</Link>
              <Link to="/terms" className="hover:text-primary transition-colors">Terms</Link>
              <Link to="/stats" className="hover:text-primary transition-colors">Stats</Link>
              <Link to="/transparency" className="hover:text-primary transition-colors">Impact</Link>
              <Link to="/changelog" className="hover:text-primary transition-colors">Changelog</Link>
            </div>
          </div>
          <div className="w-16 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
          <a
            href={feedbackMailto(pathname)}
            className="inline-flex items-center gap-1.5 text-muted-foreground/50 hover:text-primary transition-colors group"
          >
            <MessageSquare className="w-3.5 h-3.5 transition-transform group-hover:scale-110" />
            <span>Send us feedback</span>
          </a>
          <div className="w-16 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
          <Link
            to="/changelog"
            className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/40 hover:text-primary/70 transition-colors font-mono group"
            title={`Released ${RELEASE_DATE}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary/80 transition-colors" />
            v{CURRENT_VERSION}
            <span className="text-muted-foreground/25 group-hover:text-primary/40 transition-colors">— view changelog</span>
          </Link>
          <a
            href="https://github.com/REMEDiSSecurity/VulnRap.Com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-muted-foreground/50 hover:text-primary transition-colors group"
          >
            <Github className="w-3.5 h-3.5 transition-transform group-hover:scale-110" />
            <span>Open Source on GitHub</span>
          </a>
          <div className="w-16 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
          <span className="text-[10px] text-muted-foreground/30 text-center leading-relaxed">Funded and developed by the creators of <a href="https://complitt.com" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground/50 transition-colors">COMPLiTT.com</a> and <a href="https://remedissecurity.com" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground/50 transition-colors">REMEDiSSecurity.com</a></span>
        </div>
      </footer>
    </div>
  );
}
