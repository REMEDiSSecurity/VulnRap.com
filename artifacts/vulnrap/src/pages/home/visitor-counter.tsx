import { useEffect } from "react";
import { Users } from "lucide-react";
import {
  useGetVisitorStats,
  getGetVisitorStatsQueryKey,
  recordVisit,
} from "@workspace/api-client-react";

export function VisitorCounter() {
  const isDev = import.meta.env.DEV;
  const { data: visitors } = useGetVisitorStats({
    query: {
      queryKey: getGetVisitorStatsQueryKey(),
      refetchInterval: 120_000,
      enabled: !isDev,
    },
  });

  useEffect(() => {
    if (isDev) return;
    const key = "vulnrap_visit_recorded";
    const today = new Date().toISOString().slice(0, 10);
    if (sessionStorage.getItem(key) !== today) {
      recordVisit()
        .then(() => sessionStorage.setItem(key, today))
        .catch(() => {});
    }
  }, [isDev]);

  if (!visitors || visitors.totalUniqueVisitors === 0) return null;

  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground/50 py-2">
      <Users className="w-3.5 h-3.5" />
      <span>
        <span className="font-mono font-medium text-muted-foreground/70">
          {visitors.totalUniqueVisitors.toLocaleString()}
        </span>{" "}
        unique visitors
      </span>
    </div>
  );
}
