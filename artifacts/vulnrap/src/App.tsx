import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { Layout } from "@/components/layout";

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
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/results/:id" element={<Results />} />
            <Route path="/verify/:id" element={<Verify />} />
            <Route path="/check" element={<Check />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/privacy" element={<Privacy />} />
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
