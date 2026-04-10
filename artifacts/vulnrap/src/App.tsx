import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import Home from "@/pages/home";
import Results from "@/pages/results";
import Stats from "@/pages/stats";
import Privacy from "@/pages/privacy";
import Verify from "@/pages/verify";
import Check from "@/pages/check";

const queryClient = new QueryClient();

function AppRoutes() {
  return (
    <Layout>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/results/:id" element={<Results />} />
          <Route path="/verify/:id" element={<Verify />} />
          <Route path="/check" element={<Check />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
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
