// Task #417 — friendly cooldown banner for the report-submit page.
//
// The home-page submit flow (POST /api/reports) is protected by two
// rate limiters in the API server (see `lib/report-submit-cooldown.ts`
// for the wiring rationale). When either bucket trips, the
// `useSubmitReport` mutation used to surface the failure as a generic
// destructive toast that read "HTTP 429 Too Many Requests…", giving the
// submitter no indication that the failure was self-imposed and would
// resolve on its own.
//
// This banner re-uses the shared `RateLimitCooldownBanner` markup so
// the home page gets the same visual treatment + a11y wiring the
// calibration screens have used since Task #212, but with copy tailored
// to the submit flow (no reviewer-token hint — that throttle is
// orthogonal — and explicit naming of the submit limiter so the
// submitter knows why the button is disabled).

import { RateLimitCooldownBanner } from "./rate-limit-cooldown-banner";
import type { ReportSubmitCooldownState } from "@/lib/report-submit-cooldown";

export function ReportSubmitCooldownBanner({
  state,
}: {
  state: ReportSubmitCooldownState;
}) {
  return (
    <RateLimitCooldownBanner
      state={state}
      headlineLead="Too many requests"
      fallbackDetail="The report submission rate limit has temporarily blocked new uploads from this IP. The submit button is disabled until the cooldown elapses."
      limitUnitSingular="request"
      hint={
        <>
          The submit limiter is per-IP — if you're behind a shared egress,
          another user on the same network may be using the bucket. No
          action is needed; the limiter resets automatically.
        </>
      }
      testIdBase="report-submit-cooldown"
    />
  );
}
