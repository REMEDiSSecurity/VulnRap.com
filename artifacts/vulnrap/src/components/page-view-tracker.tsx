import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useRecordPageView } from "@workspace/api-client-react";

export function PageViewTracker() {
  const location = useLocation();
  const { mutate } = useRecordPageView();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;
    if (path === lastPath.current) return;
    lastPath.current = path;

    const timer = setTimeout(() => {
      mutate({ data: { path } });
    }, 300);

    return () => clearTimeout(timer);
  }, [location.pathname, mutate]);

  return null;
}
