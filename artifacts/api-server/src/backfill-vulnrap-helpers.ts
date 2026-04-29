// Helpers extracted from backfill-vulnrap.ts so they can be unit-tested
// without triggering the script's top-level CLI parsing and DB connect.
//
// Task #193 — minimal text fragments that re-trigger each
// `detectHallucinationSignals` rule. Used to reconstruct a hallucination-
// detection input for legacy reports whose raw text was not retained but
// whose v3.5.0 score-fusion run cached the original signals into the
// `evidence` jsonb column with type `hallucination_<signalType>`. Each
// snippet is engineered to fire ONLY its named signal, so a re-detection
// over the joined snippets reproduces the original totalWeight (and thus
// the same -10 / -15 / -25 composite tier) without dragging the report
// across tier boundaries via cross-contamination.
//
// Specific cross-contamination guards:
//   - `language_confusion` uses `.js` rather than `node.js` so it does not
//     suppress `impact_escalation` (whose detector skips XSS+RCE pairs that
//     mention electron/node/server-side contexts).
//   - No snippet uses ` import ` or ` def ` so `phantom_exploit_script`
//     keeps firing whenever `exploit.py` is present.
//   - The `fabricated_addresses` snippet emits 6 round addresses so even
//     when the `fabricated_stack_trace` snippet contributes 5 non-round
//     addresses to the same text the round-fraction stays >0.5.
//   - No snippet emits `SUMMARY: AddressSanitizer`, `==N==ERROR:`, gdb
//     `bt`/`backtrace`, or `READ/WRITE of size N`, so the
//     `hasRealCrashIndicators` allowlist in the detector does NOT suppress
//     `fabricated_addresses`.

import type { EvidenceItem } from "@workspace/db";

export const HALLUCINATION_TRIGGER_SNIPPETS: Record<string, string> = {
  fabricated_stack_trace: [
    "#0 0xaaaaa11111 in dup_frame",
    "#1 0xaaaaa11111 in dup_frame",
    "#2 0xaaaaa11111 in dup_frame",
    "#3 0xaaaaa11111 in dup_frame",
    "#4 0xaaaaa11111 in dup_frame",
  ].join("\n"),
  fabricated_addresses:
    "Faulting addresses 0x70000000 0x80000000 0x90000000 0xa0000000 0xb0000000 0xc0000000",
  phantom_exploit_script: "Reproduce by running exploit.py against the target.",
  // Task #206: incomplete_asan now requires a specific bug-class claim
  // alongside the missing-structure indicator, so the snippet has to name
  // the bug class explicitly (e.g. "heap-buffer-overflow") to re-fire the
  // detector at backfill time.
  incomplete_asan:
    "Reporter pasted an AddressSanitizer heap-buffer-overflow trace (truncated).",
  // Task #206: fabricated_pid no longer fires on a single magic PID when
  // no other fabrication marker is present. The snippet now seeds two
  // distinct magic PIDs so the rule fires in isolation (per-signal
  // purity) without depending on cross-talk from other snippets.
  fabricated_pid: "Crash report headers were ==12345== and ==54321==.",
  phantom_functions:
    "Mentions fab_alpha(), fab_beta(), and fab_gamma() but ships no source.",
  implausible_version: "Affects version 1.2.999 of the library.",
  impact_escalation:
    "XSS in the rendered comment escalates to RCE inside the worker.",
  language_confusion:
    "Repro mentions python pip, .js source, and #include directives.",
  repeated_sentences: [
    "Identical filler sentence with sufficient length here.",
    "Identical filler sentence with sufficient length here.",
    "Identical filler sentence with sufficient length here.",
  ].join(" "),
  empty_disclosure_claim: "Submitted under responsible disclosure.",
};

// Build trigger text for a `computeComposite` re-run from the cached
// `hallucination_*` evidence items persisted at original-analysis time.
// Returns "" when the report has no cached hallucination signals so the
// caller can pass undefined and keep the existing no-text behavior.
export function reconstructHallucinationTriggerText(
  evidence: EvidenceItem[] | null | undefined,
): string {
  if (!evidence || evidence.length === 0) return "";
  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const item of evidence) {
    if (!item.type.startsWith("hallucination_")) continue;
    const signalType = item.type.slice("hallucination_".length);
    if (seen.has(signalType)) continue;
    const snippet = HALLUCINATION_TRIGGER_SNIPPETS[signalType];
    if (snippet) {
      seen.add(signalType);
      snippets.push(snippet);
    }
  }
  return snippets.join("\n\n");
}
