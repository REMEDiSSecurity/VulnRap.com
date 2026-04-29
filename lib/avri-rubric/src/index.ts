// Task 190: single source of truth for the "AVRI Family Rubric" markdown
// section. Both the diagnostics-panel JSON/TXT export
// (`buildMarkdownSummary` in
// `artifacts/vulnrap/src/components/diagnostics-panel.tsx`) and the
// `/reports/:id/triage-report` endpoint
// (`artifacts/api-server/src/routes/reports.ts`) call into this helper so
// that future schema additions (new gold-signal field, new behavioural
// penalty, FLAT category addition, etc.) only need to land in one place
// instead of drifting between the two exports.
//
// The shape of the inputs intentionally mirrors what each consumer already
// has on hand:
//   - `composite` is the AVRI composite block emitted by Engine 2 / persisted
//     on the report row (family classification + behavioural penalties).
//   - `engine2`   is the per-engine AVRI sub-block carried under
//     `signalBreakdown.avri` on the Engine 2 entry (gold hits/misses,
//     absence penalties, contradictions, stripped-trace, fake-raw-HTTP).
//   - `overridesApplied` is the composite-level vulnrap overrides list
//     (e.g., AVRI_NO_GOLD_SIGNALS, AVRI_VELOCITY); pass [] / undefined when
//     not available and the helper will skip the "Composite overrides"
//     block.

export type AvriHandwavyCategory = "absence" | "hedging" | "buzzword";

export interface AvriCompositeBlock {
  family?: string | null;
  familyName?: string | null;
  classification?: {
    confidence?: string;
    reason?: string;
  };
  goldHitCount?: number;
  velocityPenalty?: number;
  templatePenalty?: number;
  rawCompositeBeforeBehavioralPenalties?: number;
}

export interface AvriEngine2GoldSignal {
  id: string;
  description: string;
  points: number;
}

export interface AvriEngine2AbsencePenalty {
  id: string;
  description: string;
  points: number;
  flatHandwavyCategory?: AvriHandwavyCategory;
}

export interface AvriEngine2CrashTrace {
  framesAnalyzed: number;
  goodFrames: number;
  placeholderFrames: number;
  isStripped: boolean;
  reason: string | null;
  revokedGoldHits: Array<{ id: string; points: number }>;
  penalty: number;
}

export interface AvriEngine2RawHttp {
  requestsAnalyzed: number;
  totalHeaders: number;
  placeholderHeaders: number;
  crlfPresent: boolean;
  teClConflicts: number;
  teClBroken: number;
  isFake: boolean;
  reason: string | null;
  revokedGoldHits: Array<{ id: string; points: number }>;
  penalty: number;
}

export interface AvriEngine2Block {
  family?: string | null;
  familyName?: string | null;
  goldHitCount?: number;
  goldTotalCount?: number;
  goldHits?: AvriEngine2GoldSignal[];
  goldMisses?: AvriEngine2GoldSignal[];
  absencePenalty?: number;
  absencePenalties?: AvriEngine2AbsencePenalty[];
  contradictions?: string[];
  crashTrace?: AvriEngine2CrashTrace | null;
  rawHttp?: AvriEngine2RawHttp | null;
}

export interface AvriRubricInput {
  composite: AvriCompositeBlock | null;
  engine2: AvriEngine2Block | null;
  overridesApplied?: string[];
}

const HANDWAVY_LABELS: Record<AvriHandwavyCategory, string> = {
  absence: "Self-admitted absence of evidence",
  hedging: 'Generic hedging ("may / appears")',
  buzzword: "Buzzword-soup framings",
};

const HANDWAVY_ORDER: AvriHandwavyCategory[] = [
  "absence",
  "hedging",
  "buzzword",
];

const AVRI_OVERRIDE_LABELS: Array<{ token: string; label: string }> = [
  { token: "AVRI_NO_GOLD_SIGNALS", label: "No gold signals for family" },
  {
    token: "AVRI_FAMILY_CONTRADICTION",
    label: "Report contradicts claimed family",
  },
  { token: "AVRI_VELOCITY", label: "Submission-velocity penalty" },
  { token: "AVRI_TEMPLATE_CAMPAIGN", label: "Template fingerprint reused" },
];

/**
 * Build the canonical "AVRI Family Rubric" markdown section as a list of
 * lines. Returns an empty array when neither the composite-level nor the
 * Engine 2 AVRI block is available (so callers can `lines.push(...result)`
 * without conditional checks).
 *
 * The returned lines include the `## AVRI Family Rubric` heading and a
 * trailing empty line so the section sits cleanly between other sections in
 * a longer markdown document.
 */
export function buildAvriRubricMarkdown(input: AvriRubricInput): string[] {
  const composite = input.composite;
  const engine2 = input.engine2;
  if (!composite && !engine2) return [];

  const lines: string[] = [];
  const familyName =
    composite?.familyName ??
    engine2?.familyName ??
    composite?.family ??
    engine2?.family ??
    "—";
  const familyId = composite?.family ?? engine2?.family ?? null;
  const goldHits = engine2?.goldHits ?? [];
  const goldMisses = engine2?.goldMisses ?? [];
  const absencePenalties = engine2?.absencePenalties ?? [];
  const goldHitCount = engine2?.goldHitCount ?? composite?.goldHitCount ?? 0;
  // Prefer the Engine 2 totalCount (authoritative); fall back to hit+miss
  // list length when present. When neither is available (composite-only
  // AVRI block without an Engine 2 breakdown — e.g., reconstructed reports)
  // leave the total undefined so we don't print a confusing "3/0" line.
  const computedTotal = goldHits.length + goldMisses.length;
  const goldTotalCount =
    engine2?.goldTotalCount ?? (computedTotal > 0 ? computedTotal : null);

  lines.push("## AVRI Family Rubric");
  lines.push("");
  lines.push(`- **Family**: ${familyName}`);
  if (composite?.classification?.confidence) {
    lines.push(
      `- **Classification confidence**: ${composite.classification.confidence}`,
    );
  }
  if (composite?.classification?.reason) {
    lines.push(
      `- **Classification reason**: ${composite.classification.reason}`,
    );
  }
  if (goldTotalCount != null) {
    lines.push(`- **Gold signals**: ${goldHitCount}/${goldTotalCount}`);
  } else if (goldHitCount > 0) {
    lines.push(`- **Gold signals**: ${goldHitCount}`);
  }
  if (goldHits.length > 0) {
    lines.push("- **Gold signals found**:");
    for (const g of goldHits) {
      lines.push(`  - +${g.points} ${g.description} (${g.id})`);
    }
  }
  if (goldMisses.length > 0) {
    lines.push("- **Expected signals missing**:");
    for (const g of goldMisses) {
      lines.push(`  - −${g.points} ${g.description} (${g.id})`);
    }
  }
  if (absencePenalties.length > 0) {
    lines.push(
      `- **Absence penalties applied** (haircut ${engine2?.absencePenalty ?? 0}):`,
    );
    // Mirror the FLAT-grouping the diagnostics panel does (Task 110): bucket
    // categorized hand-wavy phrases by theme so a slop FLAT export doesn't
    // dump every phrase as one ungrouped scroll. Uncategorized entries
    // (legacy payloads / non-FLAT families) keep the existing flat list.
    const categorized = absencePenalties.filter(
      (a) => a.flatHandwavyCategory != null,
    );
    const uncategorized = absencePenalties.filter(
      (a) => a.flatHandwavyCategory == null,
    );
    if (categorized.length > 0) {
      const groups = new Map<AvriHandwavyCategory, AvriEngine2AbsencePenalty[]>();
      for (const a of categorized) {
        const key = a.flatHandwavyCategory as AvriHandwavyCategory;
        const arr = groups.get(key) ?? [];
        arr.push(a);
        groups.set(key, arr);
      }
      for (const key of HANDWAVY_ORDER) {
        const items = groups.get(key);
        if (!items || items.length === 0) continue;
        const subtotal = items.reduce((s, a) => s + a.points, 0);
        lines.push(
          `  - ${HANDWAVY_LABELS[key]} (${items.length} phrase${items.length === 1 ? "" : "s"}, −${subtotal} raw):`,
        );
        for (const a of items) {
          lines.push(`    - −${a.points} ${a.description} (${a.id})`);
        }
      }
    }
    for (const a of uncategorized) {
      lines.push(`  - −${a.points} ${a.description} (${a.id})`);
    }
  }
  if (engine2?.contradictions && engine2.contradictions.length > 0) {
    lines.push(
      `- **Contradiction phrases**: ${engine2.contradictions
        .map((c) => `"${c}"`)
        .join(", ")}`,
    );
  }
  if (engine2?.crashTrace?.isStripped) {
    const ct = engine2.crashTrace;
    const traceKindLabel =
      familyId === "RACE_CONCURRENCY"
        ? "race trace"
        : familyId === "MEMORY_CORRUPTION"
          ? "crash trace"
          : "tool trace";
    lines.push(
      `- **Stripped ${traceKindLabel}** (penalty ${ct.penalty}): ${ct.reason ?? "stripped trace"} — frames ${ct.framesAnalyzed}, good ${ct.goodFrames}, placeholder ${ct.placeholderFrames}`,
    );
    if (ct.revokedGoldHits.length > 0) {
      lines.push(
        `  - Trace gold signals revoked: ${ct.revokedGoldHits.map((r) => `${r.id} (−${r.points})`).join(", ")}`,
      );
    }
  }
  if (engine2?.rawHttp?.isFake) {
    const rh = engine2.rawHttp;
    const goodHeaders = Math.max(0, rh.totalHeaders - rh.placeholderHeaders);
    lines.push(
      `- **Fake raw HTTP request** (penalty ${rh.penalty}): ${rh.reason ?? "fabricated raw HTTP request"} — requests ${rh.requestsAnalyzed}, headers ${goodHeaders}/${rh.totalHeaders} good, placeholder ${rh.placeholderHeaders}, CRLF ${rh.crlfPresent ? "yes" : "no"}, TE/CL conflicts ${rh.teClConflicts} (broken ${rh.teClBroken})`,
    );
    if (rh.revokedGoldHits.length > 0) {
      lines.push(
        `  - Smuggling gold signals revoked: ${rh.revokedGoldHits.map((r) => `${r.id} (−${r.points})`).join(", ")}`,
      );
    }
  }

  // Composite overrides: surface the AVRI-related entries from
  // vulnrapOverridesApplied (no-gold-signals, family-contradiction,
  // velocity, template) so reviewers can see *why* the composite moved on
  // top of the rubric breakdown. Mirrors the on-screen "AVRI Composite
  // Overrides" subsection in the diagnostics panel.
  const allOverrides = input.overridesApplied ?? [];
  const matchingOverrides = allOverrides
    .map((rule) => {
      const meta = AVRI_OVERRIDE_LABELS.find((m) => rule.startsWith(m.token));
      return meta ? { rule, label: meta.label, token: meta.token } : null;
    })
    .filter(
      (x): x is { rule: string; label: string; token: string } => x !== null,
    );
  const velocityPenalty = composite?.velocityPenalty ?? 0;
  const templatePenalty = composite?.templatePenalty ?? 0;
  const hasBehavioural =
    (velocityPenalty < 0 &&
      !matchingOverrides.some((o) => o.token === "AVRI_VELOCITY")) ||
    (templatePenalty < 0 &&
      !matchingOverrides.some((o) => o.token === "AVRI_TEMPLATE_CAMPAIGN"));
  if (matchingOverrides.length > 0 || hasBehavioural) {
    lines.push("- **Composite overrides**:");
    for (const o of matchingOverrides) {
      lines.push(`  - ${o.label} — \`${o.rule}\``);
    }
    if (
      velocityPenalty < 0 &&
      !matchingOverrides.some((o) => o.token === "AVRI_VELOCITY")
    ) {
      lines.push(`  - Submission-velocity penalty applied: ${velocityPenalty}`);
    }
    if (
      templatePenalty < 0 &&
      !matchingOverrides.some((o) => o.token === "AVRI_TEMPLATE_CAMPAIGN")
    ) {
      lines.push(`  - Template-fingerprint penalty applied: ${templatePenalty}`);
    }
  }
  if (
    composite &&
    typeof composite.rawCompositeBeforeBehavioralPenalties === "number"
  ) {
    lines.push(
      `- Composite before behavioural penalties: ${composite.rawCompositeBeforeBehavioralPenalties}`,
    );
  }
  lines.push("");

  return lines;
}
