import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeProvider } from "@/hooks/use-theme";
import { Layout } from "@/components/layout";
import { PageViewTracker } from "@/components/page-view-tracker";
import { ScrollToTop } from "@/components/scroll-to-top";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

function lazyRetry(importFn: () => Promise<{ default: React.ComponentType }>) {
  return lazy(() =>
    importFn().catch(() =>
      new Promise<{ default: React.ComponentType }>((resolve) => {
        setTimeout(() => {
          resolve(importFn().catch(() => ({ default: () => {
            window.location.reload();
            return null;
          }})));
        }, 1500);
      })
    )
  );
}

const Home = lazyRetry(() => import("@/pages/home"));
const Results = lazyRetry(() => import("@/pages/results"));
const Stats = lazyRetry(() => import("@/pages/stats"));
const CorpusStats = lazyRetry(() => import("@/pages/corpus-stats"));
const Privacy = lazyRetry(() => import("@/pages/privacy"));
const Verify = lazyRetry(() => import("@/pages/verify"));
const Check = lazyRetry(() => import("@/pages/check"));
const ApiDocs = lazyRetry(() => import("@/pages/api"));
const Security = lazyRetry(() => import("@/pages/security"));
const UseCases = lazyRetry(() => import("@/pages/use-cases"));
const Terms = lazyRetry(() => import("@/pages/terms"));
const Blog = lazyRetry(() => import("@/pages/blog"));
const Changelog = lazyRetry(() => import("@/pages/changelog"));
const History = lazyRetry(() => import("@/pages/history"));
const Compare = lazyRetry(() => import("@/pages/compare"));
const CompareDetectors = lazyRetry(() => import("@/pages/compare-detectors"));
const Batch = lazyRetry(() => import("@/pages/batch"));
const FeedbackAnalytics = lazyRetry(() => import("@/pages/feedback-analytics"));
const ReportsExplorer = lazyRetry(() => import("@/pages/reports"));
const Transparency = lazyRetry(() => import("@/pages/transparency"));
const Community = lazyRetry(() => import("@/pages/community"));
const Architecture = lazyRetry(() => import("@/pages/architecture"));
const EnginesSubstance = lazyRetry(() => import("@/pages/engines-substance"));
const EnginesCwe = lazyRetry(() => import("@/pages/engines-cwe"));
const EnginesAvri = lazyRetry(() => import("@/pages/engines-avri"));
const Presets = lazyRetry(() => import("@/pages/presets"));
const RedactionExamples = lazyRetry(() => import("@/pages/redaction-examples"));
const GoodReport = lazyRetry(() => import("@/pages/good-report"));
const Whitepaper = lazyRetry(() => import("@/pages/whitepaper"));
const HowItWorks = lazyRetry(() => import("@/pages/how-it-works"));
const CwePage = lazyRetry(() => import("@/pages/cwe"));
const AccessibilityPage = lazyRetry(() => import("@/pages/accessibility"));
const Quickstart = lazyRetry(() => import("@/pages/quickstart"));
const Playground = lazyRetry(() => import("@/pages/playground"));
const AuditLog = lazyRetry(() => import("@/pages/audit-log"));
const Gallery = lazyRetry(() => import("@/pages/gallery"));
const SignalsIndex = lazyRetry(() => import("@/pages/signals-index"));
const SignalsDetail = lazyRetry(() => import("@/pages/signals-detail"));
const Badges = lazyRetry(() => import("@/pages/badges"));
const Pricing = lazyRetry(() => import("@/pages/pricing"));
const Roadmap = lazyRetry(() => import("@/pages/roadmap"));
const Status = lazyRetry(() => import("@/pages/status"));
const Incidents = lazyRetry(() => import("@/pages/incidents"));
const Showcase = lazyRetry(() => import("@/pages/showcase"));
const Glossary = lazyRetry(() => import("@/pages/glossary"));
const NotFound = lazyRetry(() => import("@/pages/not-found"));

const queryClient = new QueryClient();

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AppRoutes() {
  const { helpOpen, setHelpOpen } = useKeyboardShortcuts();
  return (
    <Layout>
      <ScrollToTop />
      <PageViewTracker />
      <KeyboardShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/results/:id" element={<Results />} />
            <Route path="/verify/:id" element={<Verify />} />
            <Route path="/check" element={<Check />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/corpus-stats" element={<CorpusStats />} />
            <Route path="/developers" element={<ApiDocs />} />
            <Route path="/security" element={<Security />} />
            <Route path="/use-cases" element={<UseCases />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/blog" element={<Blog />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/changelog" element={<Changelog />} />
            <Route path="/history" element={<History />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/compare-detectors" element={<CompareDetectors />} />
            <Route path="/batch" element={<Batch />} />
            <Route path="/feedback-analytics" element={<FeedbackAnalytics />} />
            <Route path="/reports" element={<ReportsExplorer />} />
            <Route path="/transparency" element={<Transparency />} />
            <Route path="/community" element={<Community />} />
            <Route path="/architecture" element={<Architecture />} />
            <Route path="/engines/substance" element={<EnginesSubstance />} />
            <Route path="/engines/cwe-coherence" element={<EnginesCwe />} />
            <Route path="/engines/avri" element={<EnginesAvri />} />
            <Route path="/presets" element={<Presets />} />
            <Route path="/redaction-examples" element={<RedactionExamples />} />
            <Route path="/docs/good-report" element={<GoodReport />} />
            <Route path="/whitepaper" element={<Whitepaper />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/cwe" element={<CwePage />} />
            <Route path="/accessibility" element={<AccessibilityPage />} />
            <Route path="/quickstart" element={<Quickstart />} />
            <Route path="/playground" element={<Playground />} />
            <Route path="/audit-log" element={<AuditLog />} />
            <Route path="/gallery" element={<Gallery />} />
            <Route path="/signals" element={<SignalsIndex />} />
            <Route path="/signals/:id" element={<SignalsDetail />} />
            <Route path="/badges" element={<Badges />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/roadmap" element={<Roadmap />} />
            <Route path="/status" element={<Status />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/showcase" element={<Showcase />} />
            <Route path="/glossary" element={<Glossary />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AppRoutes />
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
