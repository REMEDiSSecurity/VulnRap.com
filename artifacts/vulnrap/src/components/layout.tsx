import { Link, useLocation } from "react-router-dom";
import { Activity, Shield, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import logoSrc from "@/assets/logo.png";

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-mono selection:bg-primary selection:text-primary-foreground">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 text-primary hover:opacity-80 transition-opacity">
            <img src={logoSrc} alt="VulnRap" className="w-8 h-8 rounded-sm" />
            <span className="font-bold text-xl tracking-tight uppercase">VulnRap</span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link to="/" className={cn("text-sm font-medium transition-colors hover:text-primary", pathname === "/" ? "text-primary" : "text-muted-foreground")}>
              Submit
            </Link>
            <Link to="/check" className={cn("text-sm font-medium transition-colors hover:text-primary flex items-center gap-1", pathname === "/check" ? "text-primary" : "text-muted-foreground")}>
              <Search className="w-4 h-4" /> Check
            </Link>
            <Link to="/stats" className={cn("text-sm font-medium transition-colors hover:text-primary flex items-center gap-1", pathname === "/stats" ? "text-primary" : "text-muted-foreground")}>
              <Activity className="w-4 h-4" /> Stats
            </Link>
            <Link to="/privacy" className={cn("text-sm font-medium transition-colors hover:text-primary flex items-center gap-1", pathname === "/privacy" ? "text-primary" : "text-muted-foreground")}>
              <Shield className="w-4 h-4" /> Privacy
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
      <footer className="border-t border-border py-8 mt-auto">
        <div className="container mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <img src={logoSrc} alt="" className="w-4 h-4 rounded-sm opacity-60" />
            <span>VulnRap // Free & Anonymous Vulnerability Report Validation</span>
          </div>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
            <Link to="/stats" className="hover:text-primary transition-colors">Platform Stats</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
