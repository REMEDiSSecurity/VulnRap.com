// Task #417 — Reusable rate-limit cooldown banner.
//
// Task #296 already extracted the calibration-specific cooldown banner into
// its own component so every calibration screen could share one visual
// treatment. This component is the further generalisation: the banner
// markup + countdown copy + role="alert" wiring live here, and per-page
// banners (CalibrationCooldownBanner, ReportSubmitCooldownBanner, etc.)
// supply their own copy + testId so each screen still ships with messaging
// tailored to its specific throttle while sharing the same a11y contract.
//
// Mutation buttons on each page still gate on `cooldown.active` separately
// so a stale render can't slip a click past the throttle.

import { Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { ReactNode } from "react";
import type { RateLimitCooldownState } from "@/lib/rate-limit-cooldown";

export interface RateLimitCooldownBannerProps {
  state: RateLimitCooldownState;
  /**
   * Lead-in copy used in the headline before the countdown, e.g.
   * "Too many failed attempts" → "Too many failed attempts — try again
   * in 5 seconds". Supplied per-page so the calibration banner keeps its
   * wrong-token wording while other pages can read more naturally.
   */
  headlineLead: string;
  /**
   * Fallback explainer shown when the server didn't include a friendly
   * message in the 429 body. Kept per-page so the copy can name the
   * specific limiter that tripped (e.g. "the report submission rate
   * limit", "the reviewer-token throttle").
   */
  fallbackDetail: string;
  /**
   * Optional unit copy for the limit hint. With `limit=5` and
   * `limitUnitSingular="failed attempt"` the banner reads "The limit is
   * 5 failed attempts per window." Defaults to a generic "request" so
   * pages that don't customise it still produce a sensible English
   * sentence. The plural form defaults to `${limitUnitSingular}s`.
   */
  limitUnitSingular?: string;
  limitUnitPlural?: string;
  /**
   * Optional trailing hint rendered as a third paragraph (e.g. the
   * calibration banner's "Confirm the reviewer token …" line). Pages
   * that don't have a follow-up next step can omit this.
   */
  hint?: ReactNode;
  /**
   * Stable testId base used for the banner card and headline so each
   * page's tests can target its own banner without competing with
   * other pages mounted on the same view.
   */
  testIdBase: string;
}

export function RateLimitCooldownBanner({
  state,
  headlineLead,
  fallbackDetail,
  limitUnitSingular = "request",
  limitUnitPlural,
  hint,
  testIdBase,
}: RateLimitCooldownBannerProps) {
  if (!state.active) return null;
  const seconds = Math.max(1, state.secondsRemaining);
  const headline =
    seconds === 1
      ? `${headlineLead} — try again in 1 second`
      : `${headlineLead} — try again in ${seconds} seconds`;
  const detail = state.serverMessage ?? fallbackDetail;
  const pluralUnit = limitUnitPlural ?? `${limitUnitSingular}s`;
  const limitDetail =
    state.limit != null
      ? ` The limit is ${state.limit} ${state.limit === 1 ? limitUnitSingular : pluralUnit} per window.`
      : "";
  return (
    <Card
      className="glass-card rounded-xl border-amber-500/40 bg-amber-500/5"
      role="alert"
      data-testid={`${testIdBase}-banner`}
    >
      <CardContent className="p-4 flex items-start gap-3">
        <Clock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div
            className="text-sm font-semibold text-amber-300"
            data-testid={`${testIdBase}-headline`}
          >
            {headline}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {detail}
            {limitDetail}
          </p>
          {hint ? (
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              {hint}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
