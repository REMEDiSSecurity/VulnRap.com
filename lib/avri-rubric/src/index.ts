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

export interface AvriEngine2StructuralMarker {
  id: string;
  description: string;
}

export interface AvriEngine2CrashTrace {
  framesAnalyzed: number;
  goodFrames: number;
  placeholderFrames: number;
  isStripped: boolean;
  reason: string | null;
  revokedGoldHits: Array<{ id: string; points: number }>;
  penalty: number;
  // Sprint 13B-2: structural-fabrication markers attached to the trace.
  // Optional because reports analyzed before the structural-fab detector
  // shipped won't carry them; consumers that don't render structural-fab
  // details (markdown formatter, triage export) can simply ignore them.
  structuralMarkers?: AvriEngine2StructuralMarker[];
  hasStructuralFabrication?: boolean;
  structuralFabricationPenalty?: number;
}

export interface AvriEngine2RawHttpResponse {
  responsesAnalyzed: number;
  responsesFlagged: number;
  totalHeaders: number;
  responsesMissingDate: number;
  responsesMissingServer: number;
  responsesWithSuspiciousJsonBody: number;
  responsesMissingIncidentals: number;
  isFake: boolean;
  reason: string | null;
  // Task #319 — response-side gold-signal revocations, surfaced separately
  // from the parent `AvriEngine2RawHttp.revokedGoldHits` (which is the
  // OR-merged request+response view the diagnostics panel already renders)
  // so the printable triage report can list which response-class signals
  // were revoked under the "Response Plausibility" sub-section. Optional
  // because legacy persisted reports analyzed before this field shipped
  // won't carry it; consumers default to an empty list.
  revokedGoldHits?: Array<{ id: string; points: number }>;
  // Task #450 — per-signal response-side fabrication tells (e.g.
  // `missing_date_header`, `suspicious_json_body`), each with the
  // exact wording surfaced under the "Response Plausibility"
  // sub-section. Optional because legacy persisted reports analyzed
  // before this field shipped won't carry it.
  signals?: Array<{ id: string; description: string }>;
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
  // Sprint 13B-3: nested response-side plausibility evaluation. Present
  // (but possibly with isFake=false) when the family declares response-
  // class gold signals (INJECTION, WEB_CLIENT). Null otherwise.
  response?: AvriEngine2RawHttpResponse | null;
  // Task #450 — per-signal request-side fabrication tells (e.g.
  // `placeholder_headers`, `broken_te_cl_conflict`, `missing_crlf`,
  // `no_real_header_values`, `fake_credential_token`,
  // `placeholder_body`, `prose_placeholder_payload`). Each entry has a
  // stable id (the diagnostics panel maps it onto a plain-English
  // headline) and a description carrying the exact wording shown to
  // reviewers. Optional because legacy persisted reports analyzed
  // before this field shipped won't carry it.
  signals?: Array<{ id: string; description: string }>;
}

// Task #300 — AI self-disclosure detector. Surfaced on the AVRI Engine 2
// block so the diagnostics panel and triage export can show reviewers
// exactly which self-disclosure phrase(s) fired and how much was deducted.
// Optional because reports analyzed before the detector shipped won't
// carry it; consumers that don't render it can simply ignore the field.
export interface AvriEngine2AiSelfDisclosureMatch {
  id: string;
  excerpt: string;
}

export interface AvriEngine2AiSelfDisclosure {
  detected: boolean;
  matches: AvriEngine2AiSelfDisclosureMatch[];
  /** Negative number when applied; 0 when no phrase matched. */
  penalty: number;
}

export interface AvriEngine2Block {
  family?: string | null;
  familyName?: string | null;
  // Normalized AVRI base score (gold hits scaled against the family's
  // calibrated max). Optional — not all consumers (e.g. the markdown
  // formatter) read it, but the engine writes it on every fresh report.
  baseScore?: number;
  goldHitCount?: number;
  goldTotalCount?: number;
  goldHits?: AvriEngine2GoldSignal[];
  goldMisses?: AvriEngine2GoldSignal[];
  absencePenalty?: number;
  absencePenalties?: AvriEngine2AbsencePenalty[];
  contradictions?: string[];
  contradictionPenalty?: number;
  crashTrace?: AvriEngine2CrashTrace | null;
  rawHttp?: AvriEngine2RawHttp | null;
  // Task #300 — AI self-disclosure detector output. Optional so older
  // persisted reports without the field continue to render normally.
  aiSelfDisclosure?: AvriEngine2AiSelfDisclosure | null;
  // Final score components: AVRI raw (after penalties), legacy substance
  // score, and the blended Engine 2 score that lands on `engine.score`.
  rawAvriScore?: number;
  legacyScore?: number;
  blendedScore?: number;
}

export interface AvriRubricInput {
  composite: AvriCompositeBlock | null;
  engine2: AvriEngine2Block | null;
  overridesApplied?: string[];
  docsLink?: string | null;
}

// Task 272: also exported for the on-screen `AvriFamilySection` React
// component in `artifacts/vulnrap/src/components/diagnostics-panel.tsx` so
// the panel groups absence-penalty buckets in the same order and with the
// same wording as the markdown export.
export const HANDWAVY_CATEGORY_LABELS: Record<AvriHandwavyCategory, string> = {
  absence: "Self-admitted absence of evidence",
  hedging: 'Generic hedging ("may / appears")',
  buzzword: "Buzzword-soup framings",
};

export const HANDWAVY_CATEGORY_ORDER: AvriHandwavyCategory[] = [
  "absence",
  "hedging",
  "buzzword",
];

// Task #467 — plain-English labels for the strong-evidence GOLD_SIGNAL
// category ids surfaced in the diagnostics panel's "Strong-Evidence Bonus
// (Gold Categories)" section AND its markdown export. Lives in the
// shared `@workspace/avri-rubric` package so the server-side weight table
// (`GOLD_SIGNAL_WEIGHTS` in
// `artifacts/api-server/src/lib/engines/gold-signals.ts`, which re-exports
// this same constant) and the client-side renderer cannot drift. Keep the
// keys in lock-step with `GOLD_SIGNAL_WEIGHTS`; a sync test in
// `gold-signals.test.ts` enforces full coverage.
export const GOLD_SIGNAL_LABELS: Readonly<Record<string, string>> = {
  // Curated three (Task #170).
  real_crash_trace: "Real ASan/sanitizer crash trace",
  real_raw_http: "Real raw HTTP/1.x request bytes",
  code_diff: "Code diff hunk for the fix or repro",
  // Additional ten (Task #174).
  sql_injection_payload:
    "SQL injection payload (UNION SELECT / OR 1=1 / SLEEP / etc.)",
  command_injection_payload:
    "Command/JNDI injection payload (;cat /etc/passwd, $(...), ${jndi:…})",
  xss_payload: "Concrete XSS payload with active sink (alert/cookie/fetch)",
  ssrf_metadata_target:
    "SSRF target: cloud-metadata URL with concrete path",
  path_traversal_payload:
    "Path traversal reaching a sensitive file (e.g. ../../etc/passwd)",
  xxe_external_entity:
    "XML external entity declaration with concrete URI",
  deserialization_gadget:
    "Concrete deserialization gadget chain or unsafe-load sink",
  auth_token: "Authentication footprint: real JWT/Bearer/session value",
  crypto_misuse:
    "Crypto misuse (static IV/key, ECB mode, MD5/SHA1, DES/3DES/RC4)",
  filesystem_toctou:
    "Filesystem TOCTOU: stat/access followed by open on related path",
};

// Task 272: also exported so the on-screen panel's "AVRI Composite
// Overrides" section reads label wording (and the set of recognised
// tokens) from the same table the markdown export uses.
export const AVRI_OVERRIDE_LABELS: Array<{ token: string; label: string }> = [
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
  const docsLink =
    typeof input.docsLink === "string" ? input.docsLink.trim() : "";
  if (docsLink.length > 0) {
    lines.push(`_Learn more about the AVRI Family Rubric: ${docsLink}_`);
    lines.push("");
  }
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
      for (const key of HANDWAVY_CATEGORY_ORDER) {
        const items = groups.get(key);
        if (!items || items.length === 0) continue;
        const subtotal = items.reduce((s, a) => s + a.points, 0);
        lines.push(
          `  - ${HANDWAVY_CATEGORY_LABELS[key]} (${items.length} phrase${items.length === 1 ? "" : "s"}, −${subtotal} raw):`,
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
  const traceKindLabel =
    familyId === "RACE_CONCURRENCY"
      ? "race trace"
      : familyId === "MEMORY_CORRUPTION"
        ? "crash trace"
        : "tool trace";
  if (engine2?.crashTrace?.isStripped) {
    const ct = engine2.crashTrace;
    lines.push(
      `- **Stripped ${traceKindLabel}** (penalty ${ct.penalty}): ${ct.reason ?? "stripped trace"} — frames ${ct.framesAnalyzed}, good ${ct.goodFrames}, placeholder ${ct.placeholderFrames}`,
    );
    if (ct.revokedGoldHits.length > 0) {
      lines.push(
        `  - Trace gold signals revoked: ${ct.revokedGoldHits.map((r) => `${r.id} (−${r.points})`).join(", ")}`,
      );
    }
  }
  // Task #317: surface the Sprint 13B-2 / Task #303 structural-fabrication
  // markers (round offsets, frame-numbering gaps, missing PID anchor, hex
  // region size, implausible function offsets / thread ids, region-vs-
  // access mismatch). Mirrors the diagnostics-panel UI block so a copied
  // markdown summary or printable triage report carries the same evidence
  // the on-screen panel shows. Renders independently of `isStripped` so
  // both flags can appear in the same export when both fired.
  const ct = engine2?.crashTrace;
  if (
    ct?.hasStructuralFabrication &&
    ct.structuralMarkers &&
    ct.structuralMarkers.length > 0
  ) {
    const penalty = ct.structuralFabricationPenalty ?? 0;
    const penaltyNote =
      penalty < 0
        ? `penalty ${penalty}`
        : "penalty subsumed by stripped-trace";
    lines.push(
      `- **Structural fabrication in ${traceKindLabel}** (${penaltyNote}): ${ct.structuralMarkers.length} marker${ct.structuralMarkers.length === 1 ? "" : "s"} fired`,
    );
    for (const m of ct.structuralMarkers) {
      lines.push(`  - ${m.description} (${m.id})`);
    }
  }
  // Task #300 — AI self-disclosure (e.g. "prepared using an AI security
  // assistant"). Surfaced ahead of raw-HTTP so it lives next to the other
  // out-of-cap penalty rows in the rubric block.
  if (engine2?.aiSelfDisclosure?.detected) {
    const ai = engine2.aiSelfDisclosure;
    lines.push(
      `- **AI self-disclosure** (penalty ${ai.penalty}): ${ai.matches.length} phrase${ai.matches.length === 1 ? "" : "s"} matched`,
    );
    for (const m of ai.matches) {
      lines.push(`  - "${m.excerpt}" (${m.id})`);
    }
  }
  if (engine2?.rawHttp?.isFake) {
    const rh = engine2.rawHttp;
    const goodHeaders = Math.max(0, rh.totalHeaders - rh.placeholderHeaders);
    // Sprint 13B-3: title now reflects whether the request side, the
    // response side, or both were fabricated. The single penalty line
    // covers either source (out-of-cap penalty applied once).
    const reqFake = rh.requestsAnalyzed > 0 || rh.placeholderHeaders > 0;
    const respFake = rh.response?.isFake === true;
    const title =
      reqFake && respFake
        ? "Fake raw HTTP request + response"
        : respFake && !reqFake
          ? "Fake raw HTTP response"
          : "Fake raw HTTP request";
    lines.push(
      `- **${title}** (penalty ${rh.penalty}): ${rh.reason ?? "fabricated raw HTTP bytes"} — requests ${rh.requestsAnalyzed}, headers ${goodHeaders}/${rh.totalHeaders} good, placeholder ${rh.placeholderHeaders}, CRLF ${rh.crlfPresent ? "yes" : "no"}, TE/CL conflicts ${rh.teClConflicts} (broken ${rh.teClBroken})`,
    );
    // Task #450 — surface every request-side fabrication signal that
    // fired (placeholder headers, broken TE/CL conflict, missing CRLF,
    // no real header values, fake credential token, placeholder body,
    // prose placeholder payload) as `description (id)` sub-bullets,
    // mirroring the structural-fabrication marker lines emitted above.
    // Skipped for legacy persisted reports without `signals`.
    const reqSignals = rh.signals ?? [];
    if (reqSignals.length > 0) {
      for (const s of reqSignals) {
        lines.push(`  - ${s.description} (${s.id})`);
      }
    }
    // Task #319 — surface the response-side plausibility evidence as a
    // proper "Response Plausibility" sub-section under the raw-HTTP block
    // (per-marker counters + response-class revoked gold signal ids) so the
    // printable triage report carries the same fabricated-response markers
    // the diagnostics panel already shows. The parent `revokedGoldHits`
    // line below still lists *all* revoked ids for backward compatibility.
    if (respFake && rh.response) {
      const r = rh.response;
      lines.push(
        `  - **Response Plausibility** (${r.responsesFlagged}/${r.responsesAnalyzed} response block${r.responsesAnalyzed === 1 ? "" : "s"} flagged):`,
      );
      if (r.reason) {
        lines.push(`    - ${r.reason}`);
      }
      lines.push(`    - Missing Date header: ${r.responsesMissingDate}`);
      lines.push(`    - Missing Server header: ${r.responsesMissingServer}`);
      lines.push(
        `    - Suspiciously clean JSON body: ${r.responsesWithSuspiciousJsonBody}`,
      );
      lines.push(
        `    - Missing incidental headers: ${r.responsesMissingIncidentals}`,
      );
      // Task #450 — per-signal response-side fabrication tells, listed
      // as `description (id)` sub-bullets so the printable triage
      // report carries the same per-signal evidence the diagnostics
      // panel renders. Skipped for legacy persisted reports without
      // `signals`.
      const respSignals = r.signals ?? [];
      if (respSignals.length > 0) {
        for (const s of respSignals) {
          lines.push(`    - ${s.description} (${s.id})`);
        }
      }
      const respRevoked = r.revokedGoldHits ?? [];
      if (respRevoked.length > 0) {
        lines.push(
          `    - Response gold signals revoked: ${respRevoked.map((g) => `${g.id} (−${g.points})`).join(", ")}`,
        );
      }
    }
    if (rh.revokedGoldHits.length > 0) {
      lines.push(
        `  - Gold signals revoked: ${rh.revokedGoldHits.map((r) => `${r.id} (−${r.points})`).join(", ")}`,
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
