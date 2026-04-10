import { Link, useLocation } from "react-router-dom";
import { Activity, Shield, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import logoSrc from "@/assets/logo.png";
import { LaserEffects } from "@/components/laser-effects";

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div className="laser-content-layer min-h-screen bg-background text-foreground flex flex-col font-mono selection:bg-primary selection:text-primary-foreground">
      <div className="cyber-grid" aria-hidden="true" />
      <LaserEffects />
      <header className="nav-glass sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 group">
            <img src={logoSrc} alt="VulnRap" className="w-8 h-8 rounded-sm transition-transform group-hover:scale-110" />
            <span className="font-bold text-xl tracking-tight uppercase text-primary glow-text-sm transition-all group-hover:glow-text">VulnRap</span>
          </Link>
          <nav className="flex items-center gap-1">
            {[
              { to: "/", label: "Submit", icon: null, match: pathname === "/" },
              { to: "/check", label: "Check", icon: <Search className="w-3.5 h-3.5" />, match: pathname === "/check" },
              { to: "/stats", label: "Stats", icon: <Activity className="w-3.5 h-3.5" />, match: pathname === "/stats" },
              { to: "/privacy", label: "Privacy", icon: <Shield className="w-3.5 h-3.5" />, match: pathname === "/privacy" },
            ].map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "text-sm font-medium transition-all px-3 py-1.5 rounded-md flex items-center gap-1.5",
                  item.match
                    ? "text-primary bg-primary/10 glow-text-sm"
                    : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                )}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
      <footer className="footer-gradient py-10 mt-auto">
        <div className="container mx-auto px-4 flex flex-col items-center gap-4 text-xs text-muted-foreground">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 w-full">
            <div className="flex items-center gap-2.5">
              <img src={logoSrc} alt="" className="w-5 h-5 rounded-sm opacity-50" />
              <span className="text-muted-foreground/70">VulnRap // Free & Anonymous Vulnerability Report Validation</span>
            </div>
            <div className="flex gap-5">
              <Link to="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
              <Link to="/stats" className="hover:text-primary transition-colors">Platform Stats</Link>
            </div>
          </div>
          <div className="w-16 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
          <span className="text-[10px] text-muted-foreground/30">Funded and developed by the creators of <a href="https://complitt.com" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground/50 transition-colors">COMPLiTT.com</a> and <a href="https://remedissecurity.com" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground/50 transition-colors">REMEDiSSecurity.com</a></span>
        </div>
      </footer>
    </div>
  );
}
