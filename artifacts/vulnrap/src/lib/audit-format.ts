// Task #477 — Single source of truth for the reviewer-facing
// "audit timestamp" format ("Apr 22, 2026, 10:00 AM"). This used to be a
// local helper inside `pages/feedback-analytics.tsx`, but shared components
// (e.g. `HandwavyCategoryFlipBadge`) need to render the same format without
// taking a prop-injected formatter and without depending on the 12k-line
// page module.
export function formatAuditTimestamp(
  iso: string | undefined | null,
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
