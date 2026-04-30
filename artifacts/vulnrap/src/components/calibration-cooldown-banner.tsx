// Task #296 — Reusable wrong-token cooldown banner.
//
// Task #212 introduced this banner inline in `feedback-analytics.tsx` so the
// calibration dashboard + handwavy admin could surface the per-IP throttle
// (Task #116) as a friendly countdown instead of a raw "HTTP 429" toast.
// Other calibration-flavoured surfaces (the AVRI drift dashboard, its
// "notified flags" re-arm panel, future calibration screens) were still
// surfacing the raw toast even though `useCalibrationCooldown()` already
// receives every 429 from the shared rate-limit observer.
//
// Pulling the banner into its own component keeps every calibration screen
// rendering the exact same visual treatment, with the same headline,
// detail copy, and "confirm the reviewer token" hint, instead of each
// screen re-implementing it (and inevitably drifting). Mutation buttons
// on each screen still gate on `cooldown.active` separately so a stale
// render can't slip a click past the throttle.

import { Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { CalibrationCooldownState } from "@/lib/calibration-cooldown";

export function CalibrationCooldownBanner({
  state,
}: {
  state: CalibrationCooldownState;
}) {
  if (!state.active) return null;
  const seconds = Math.max(1, state.secondsRemaining);
  const headline =
    seconds === 1
      ? "Too many failed attempts — try again in 1 second"
      : `Too many failed attempts — try again in ${seconds} seconds`;
  const detail =
    state.serverMessage ??
    "The reviewer-token throttle has temporarily blocked calibration mutations from this IP. Mutation buttons are disabled until the cooldown elapses.";
  const limitDetail =
    state.limit != null
      ? ` The limit is ${state.limit} failed attempt${state.limit === 1 ? "" : "s"} per window.`
      : "";
  return (
    <Card
      className="glass-card rounded-xl border-amber-500/40 bg-amber-500/5"
      role="alert"
      data-testid="calibration-cooldown-banner"
    >
      <CardContent className="p-4 flex items-start gap-3">
        <Clock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div
            className="text-sm font-semibold text-amber-300"
            data-testid="calibration-cooldown-headline"
          >
            {headline}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {detail}
            {limitDetail}
          </p>
          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            Confirm the reviewer token (<code className="font-mono text-[11px]">VITE_CALIBRATION_TOKEN</code>)
            matches the server's <code className="font-mono text-[11px]">CALIBRATION_TOKEN</code>{" "}
            before retrying — every wrong-token attempt extends the bucket.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
