import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, Search, Code, BookOpen, Target, MessageSquare, Menu, X, Github, Clock, GitCompare, UploadCloud, BarChart3 } from "lucide-react";
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

const NAV_ITEMS = [
  { to: "/", label: "Submit", icon: null },
  { to: "/check", label: "Check", icon: <Search className="w-3.5 h-3.5" /> },
  { to: "/batch", label: "Batch", icon: <UploadCloud className="w-3.5 h-3.5" /> },
  { to: "/compare", label: "Compare", icon: <GitCompare className="w-3.5 h-3.5" /> },
  { to: "/history", label: "History", icon: <Clock className="w-3.5 h-3.5" /> },
  { to: "/stats", label: "Stats", icon: <Activity className="w-3.5 h-3.5" /> },
  { to: "/feedback-analytics", label: "Feedback", icon: <BarChart3 className="w-3.5 h-3.5" /> },
  { to: "/developers", label: "API", icon: <Code className="w-3.5 h-3.5" /> },
  { to: "/blog", label: "Blog", icon: <BookOpen className="w-3.5 h-3.5" /> },
];

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
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "text-sm font-medium transition-all px-3 py-1.5 rounded-md flex items-center gap-1.5 whitespace-nowrap",
                  (item.to === "/" ? pathname === "/" : pathname.startsWith(item.to))
                    ? "text-primary bg-primary/10 glow-text-sm"
                    : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                )}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
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
            className="relative border-b border-primary/15"
            style={{ backgroundColor: "hsl(220, 30%, 6%)" }}
          >
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileMenuOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3.5 rounded-lg text-base font-semibold transition-all",
                    (item.to === "/" ? pathname === "/" : pathname.startsWith(item.to))
                      ? "text-primary bg-primary/15 glow-text-sm"
                      : "text-white/90 hover:text-primary hover:bg-primary/5"
                  )}
                >
                  <span className="w-5 flex items-center justify-center">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
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
