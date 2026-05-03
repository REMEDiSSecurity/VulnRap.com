// Task #724 — Tiny store for the most recent server-side X-Request-Id.
//
// The shared API client publishes the request id of every failed call to its
// `addErrorRequestIdObserver` channel. This module subscribes once, keeps
// the most recent value in memory, and exposes a React hook so any
// user-visible error UI (error-boundary, toast, custom error page) can
// quote a "Reference ID" the operator can grep for in the api-server logs.
import { useEffect, useState } from "react";
import {
  addErrorRequestIdObserver,
  type ErrorRequestIdNotice,
} from "@workspace/api-client-react";

let latest: ErrorRequestIdNotice | null = null;
const subscribers = new Set<(value: ErrorRequestIdNotice | null) => void>();

let bootstrapped = false;
function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  addErrorRequestIdObserver((notice) => {
    latest = notice;
    for (const sub of Array.from(subscribers)) {
      try {
        sub(notice);
      } catch {
        // Ignore subscriber errors so one bad listener can't break others.
      }
    }
  });
}

export function getLastErrorRequestId(): ErrorRequestIdNotice | null {
  bootstrap();
  return latest;
}

export function useLastErrorRequestId(): ErrorRequestIdNotice | null {
  bootstrap();
  const [value, setValue] = useState<ErrorRequestIdNotice | null>(latest);
  useEffect(() => {
    const sub = (next: ErrorRequestIdNotice | null) => setValue(next);
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, []);
  return value;
}
