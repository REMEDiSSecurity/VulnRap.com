import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { Layout } from "@/components/layout";
import { PageViewTracker } from "@/components/page-view-tracker";

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
const Batch = lazyRetry(() => import("@/pages/batch"));
const FeedbackAnalytics = lazyRetry(() => import("@/pages/feedback-analytics"));
const ReportsExplorer = lazyRetry(() => import("@/pages/reports"));
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
  return (
    <Layout>
      <PageViewTracker />
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/results/:id" element={<Results />} />
            <Route path="/verify/:id" element={<Verify />} />
            <Route path="/check" element={<Check />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/developers" element={<ApiDocs />} />
            <Route path="/security" element={<Security />} />
            <Route path="/use-cases" element={<UseCases />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/blog" element={<Blog />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/changelog" element={<Changelog />} />
            <Route path="/history" element={<History />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/batch" element={<Batch />} />
            <Route path="/feedback-analytics" element={<FeedbackAnalytics />} />
            <Route path="/reports" element={<ReportsExplorer />} />
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
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppRoutes />
          </BrowserRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
