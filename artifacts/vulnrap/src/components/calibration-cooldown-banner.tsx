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
//
// Task #417 generalised the markup into `RateLimitCooldownBanner` so other
// mutation-heavy pages (report-submit today) can share the same visual
// treatment with their own copy + testIds. This component now configures
// the generic banner with the calibration-specific lead-in, fallback
// explainer, limit unit, and reviewer-token hint while keeping its
// existing `calibration-cooldown-*` testIds so calibration tests don't
// have to migrate.

import { RateLimitCooldownBanner } from "./rate-limit-cooldown-banner";
import type { CalibrationCooldownState } from "@/lib/calibration-cooldown";

export function CalibrationCooldownBanner({
  state,
}: {
  state: CalibrationCooldownState;
}) {
  return (
    <RateLimitCooldownBanner
      state={state}
      headlineLead="Too many failed attempts"
      fallbackDetail="The reviewer-token throttle has temporarily blocked calibration mutations from this IP. Mutation buttons are disabled until the cooldown elapses."
      limitUnitSingular="failed attempt"
      limitUnitPlural="failed attempts"
      hint={
        <>
          Confirm the reviewer token (
          <code className="font-mono text-[11px]">VITE_CALIBRATION_TOKEN</code>
          ) matches the server's{" "}
          <code className="font-mono text-[11px]">CALIBRATION_TOKEN</code>{" "}
          before retrying — every wrong-token attempt extends the bucket.
        </>
      }
      testIdBase="calibration-cooldown"
    />
  );
}
