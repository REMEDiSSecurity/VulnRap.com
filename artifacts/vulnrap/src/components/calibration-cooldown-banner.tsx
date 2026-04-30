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
// treatment with their own copy + testIds. The view helper below now
// configures the generic banner with the calibration-specific lead-in,
// fallback explainer, limit unit, and reviewer-token hint while keeping
// its existing `calibration-cooldown-*` testIds so calibration tests
// don't have to migrate.
//
// Task #419 — When more than one calibration section is rendered on the
// same page (the feedback-analytics page mounts the calibration dashboard,
// the handwavy admin, and the AVRI drift admin in sequence), each section
// previously rendered its own copy of the banner — so a single 429 stacked
// up to three identical banners. The `CalibrationCooldownBannerProvider`
// below acts as a small page-level coordinator: when the banner is rendered
// inside a provider, only the topmost-in-document-order instance actually
// renders the visible card; the rest drop a hidden sentinel so the
// coordinator can keep electing the right "topmost" as sections mount and
// unmount. When the banner is rendered standalone (no provider), it renders
// as it always has — keeping the per-section opt-in goal intact for any
// future screen that wants to surface the same throttle treatment without
// being on the calibration dashboard.

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { RateLimitCooldownBanner } from "./rate-limit-cooldown-banner";
import type { CalibrationCooldownState } from "@/lib/calibration-cooldown";

// Coordinator context. `null` means the banner is being rendered standalone
// (no provider in the tree) — that path keeps the original "always render"
// behaviour so a single calibration screen mounted on its own page still
// surfaces the throttle without the consumer having to add the provider.
interface CalibrationCooldownBannerCoordinator {
  register: (id: string, ref: RefObject<HTMLElement | null>) => void;
  unregister: (id: string) => void;
  isTopmost: (id: string) => boolean;
}

const CalibrationCooldownBannerContext =
  createContext<CalibrationCooldownBannerCoordinator | null>(null);

export function CalibrationCooldownBannerProvider({
  children,
}: {
  children: ReactNode;
}) {
  // Refs map persists across renders without forcing a re-render itself —
  // we only flip state when the *set* of registered banners or their DOM
  // ordering changes.
  const refsRef = useRef(new Map<string, RefObject<HTMLElement | null>>());
  const [registered, setRegistered] = useState<ReadonlyArray<string>>([]);
  const [topmostId, setTopmostId] = useState<string | null>(null);

  const register = useCallback(
    (id: string, ref: RefObject<HTMLElement | null>) => {
      refsRef.current.set(id, ref);
      setRegistered((prev) => (prev.includes(id) ? prev : [...prev, id]));
    },
    [],
  );

  const unregister = useCallback((id: string) => {
    refsRef.current.delete(id);
    setRegistered((prev) => prev.filter((x) => x !== id));
  }, []);

  // Re-elect the topmost banner whenever the registered set changes. We
  // can't rely on registration order — useLayoutEffect fires children-
  // before-parents, which means a deeply-nested section would always
  // register first even when its visual position is below a sibling
  // section's banner. Falling back to `compareDocumentPosition` over the
  // sentinel refs picks the genuinely-topmost one regardless of mount
  // order. We still guard against missing ref nodes (e.g. between a
  // register call and the first paint) by skipping unattached entries.
  //
  // Election runs in useLayoutEffect — synchronously after commit, before
  // the browser paints — so reviewers don't see a one-frame flash where
  // either no banner or the previous topmost is on screen while the new
  // one is being elected after a mount-order change.
  useLayoutEffect(() => {
    if (registered.length === 0) {
      setTopmostId(null);
      return;
    }
    let bestId: string | null = null;
    let bestNode: HTMLElement | null = null;
    for (const id of registered) {
      const node = refsRef.current.get(id)?.current ?? null;
      if (!node) continue;
      if (!bestNode) {
        bestId = id;
        bestNode = node;
        continue;
      }
      const cmp = bestNode.compareDocumentPosition(node);
      // DOCUMENT_POSITION_PRECEDING (0x02) — node comes before bestNode in
      // document order, so node is the new "topmost" candidate.
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) {
        bestId = id;
        bestNode = node;
      }
    }
    // Fall back to the first registration if no ref was attached yet — the
    // next paint will re-run this effect with attached refs and correct it.
    setTopmostId(bestId ?? registered[0] ?? null);
  }, [registered]);

  const isTopmost = useCallback(
    (id: string) => topmostId === id,
    [topmostId],
  );

  const value = useMemo<CalibrationCooldownBannerCoordinator>(
    () => ({ register, unregister, isTopmost }),
    [register, unregister, isTopmost],
  );

  return (
    <CalibrationCooldownBannerContext.Provider value={value}>
      {children}
    </CalibrationCooldownBannerContext.Provider>
  );
}

// The visible card. Split out from the public component so the provider
// path can render the same UI without re-running the registration logic.
function CalibrationCooldownBannerView({
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

export function CalibrationCooldownBanner({
  state,
}: {
  state: CalibrationCooldownState;
}) {
  const coord = useContext(CalibrationCooldownBannerContext);
  const reactId = useId();
  const sentinelRef = useRef<HTMLSpanElement | null>(null);

  // Register synchronously during commit so the coordinator can elect a
  // topmost before the next paint (avoids a single-frame flash where two
  // banners might briefly render together). useLayoutEffect's child-first
  // order doesn't matter for correctness here — the election effect in the
  // provider re-runs against the live DOM and uses compareDocumentPosition.
  useLayoutEffect(() => {
    if (!coord) return;
    coord.register(reactId, sentinelRef);
    return () => coord.unregister(reactId);
  }, [coord, reactId]);

  if (!coord) {
    // Standalone (no provider) — original behaviour.
    return <CalibrationCooldownBannerView state={state} />;
  }

  const showBanner = coord.isTopmost(reactId);

  // The hidden sentinel keeps a foothold in the DOM at this banner's
  // intended location even when this instance isn't the visible one, so
  // compareDocumentPosition can keep electing the topmost as sections
  // mount or unmount. data-testid lets tests assert the coordinator is
  // wired up without coupling to the visible-banner testid.
  return (
    <>
      <span
        ref={sentinelRef}
        aria-hidden="true"
        style={{ display: "none" }}
        data-testid="calibration-cooldown-banner-sentinel"
      />
      {showBanner && <CalibrationCooldownBannerView state={state} />}
    </>
  );
}
