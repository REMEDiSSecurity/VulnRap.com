// Family-agnostic slop signals applied at the AVRI composite layer.
//
// These detect generic patterns that mark a report as low-evidence regardless
// of the family rubric. Family rubrics already cover family-specific gold and
// absence, but some slop patterns (e.g. quoting a "patch" in prose without
// any actual diff) cut across families and would otherwise score normally
// when the family happens to lack a strong diff-gold signal.

export interface SlopSignalResult {
  points: number;
  reason: string | null;
}

/**
 * Detect "patch-shaped prose without an actual diff": a report that claims to
 * provide a patch / fix / diff but does not contain any real diff hunk or
 * code-fenced patch. This catches slop that quotes a fix in plain English
 * (or a markdown blockquote) and relies on the reviewer to imagine the code.
 *
 * The penalty is family-agnostic so reports cannot escape it by being
 * classified into a family whose gold rubric does not require a diff.
 */
export function fabricatedPatchPenalty(text: string): SlopSignalResult {
  // 1. Did the report explicitly claim to be presenting a patch / fix / diff?
  //    Use narrow phrasings ("suggested patch", "here is the fix", etc.) so
  //    we don't fire on legitimate reports that simply say "Fix:" before a
  //    real diff or a one-line description of the remediation.
  const patchClaimPatterns: RegExp[] = [
    /\b(?:suggested|proposed|illustrative|recommended|tentative|rough|sketch(?:ed)?|pseudo)\s+patch\b/i,
    /\bpatch\s*\([^)]{0,40}(?:illustrative|from\s+memory|approximate|sketch|pseudo|untested)/i,
    /\b(?:suggested|proposed|recommended|tentative|illustrative)\s+(?:fix|diff)\b/i,
    /\bsuggested\s+remediation(?:\s+patch)?\b/i,
    /\bhere(?:'s|\s+is)\s+(?:the|a|my|an?\s+illustrative)\s+(?:fix|patch|diff)\b/i,
    /\b(?:wrote|drafted|composed|reconstructed|written)\s+(?:the\s+)?(?:fix|patch|diff)\s+from\s+memory\b/i,
    /\b(?:fix|patch|diff)\s*[:\-]?\s*\(?\s*(?:illustrative|written\s+from\s+memory|from\s+memory|approximate|pseudo(?:code)?|untested)/i,
  ];
  const claimsPatch = patchClaimPatterns.some((p) => p.test(text));
  if (!claimsPatch) return { points: 0, reason: null };

  // 2. Real diff hunk markers anywhere in the report?
  const diffHunkRe =
    /(?:^|\n)(?:diff --git\s|---\s+\S+|\+\+\+\s+\S+|@@\s+-?\d+(?:,\d+)?\s+\+?\d+)/;
  if (diffHunkRe.test(text)) return { points: 0, reason: null };

  // 3. Or a code-fenced block with leading +/- lines (loose unified-diff
  //    style without a/b headers)?
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const hasPlusMinusInCode = codeBlocks.some((b) => /\n\s*[+\-]\s*\S/.test(b));
  if (hasPlusMinusInCode) return { points: 0, reason: null };

  // 4. Or any code-fenced block at all that looks like source the reviewer
  //    can read as the "patched" function (≥2 non-empty lines)? Many T1
  //    legitimate reports show a corrected snippet without diff markers.
  const hasSubstantiveCode = codeBlocks.some((b) => {
    const inner = b.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
    const lines = inner.split("\n").filter((l) => l.trim().length > 0);
    return lines.length >= 2;
  });
  if (hasSubstantiveCode) return { points: 0, reason: null };

  return {
    points: -10,
    reason:
      "AVRI_FABRICATED_PATCH: report claims a patch/fix without a real diff hunk or code block (-10)",
  };
}
