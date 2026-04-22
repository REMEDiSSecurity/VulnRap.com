import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { performActiveVerification } from "./active-verification.js";

// Mock fetch so the verification routing tests do not hit GitHub or NVD.
// Each mode-specific test asserts which check *types* appear, so the actual
// HTTP status returned is mostly irrelevant — we just need a deterministic
// response that drives the same code paths regardless of network state.
function mockFetch(handler: (url: string) => { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body ?? {},
    } as Response;
  }));
}

describe("performActiveVerification — verification routing", () => {
  beforeEach(() => {
    // 404 on every external call — yields github_file_missing / nvd
    // not-found checks without depending on the network.
    mockFetch(() => ({ ok: false, status: 404 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each test uses unique text so the in-process L1 cache cannot leak between
  // tests. (Cross-test cache bleed would itself be a regression we want to
  // surface, but keep the routing tests independent of that concern.)
  const sourceCodeText = `
    Heap-overflow in https://github.com/curl/curl when parsing TLS records.
    See src/vtls/openssl.c and the Curl_ossl_init function.
    The bug is similar to CVE-2099-99999 disclosed last week.
  `;

  const endpointText = `
    Reflected XSS at https://target.com/search?q=<script>alert('xss')</script>
    Reproduction:
      curl https://target.com/search?q=<script>alert(1)</script>
    HTTP/1.1 200 OK
    X-Test: yes

  `;

  const manualText = `
    Race condition between check and use in the session validator.
    Fast attacker may swap the file under FOO_PATH after access() succeeds.
    Tracked as CVE-2099-99999.
  `;

  it("SOURCE_CODE mode runs github_* checks and skips poc_* checks", async () => {
    const r = await performActiveVerification(sourceCodeText, {
      verificationMode: "SOURCE_CODE",
    });
    const types = r.checks.map((c) => c.type);
    expect(types.some((t) => t.startsWith("github_"))).toBe(true);
    expect(types.some((t) => t.startsWith("poc_"))).toBe(false);
    expect(types.includes("manual_review_required")).toBe(false);
  });

  it("ENDPOINT mode runs poc_* checks and skips github_* checks", async () => {
    const r = await performActiveVerification(endpointText, {
      verificationMode: "ENDPOINT",
    });
    const types = r.checks.map((c) => c.type);
    expect(types.some((t) => t.startsWith("poc_"))).toBe(true);
    expect(types.some((t) => t.startsWith("github_"))).toBe(false);
    expect(types.includes("manual_review_required")).toBe(false);
  });

  it("MANUAL_ONLY mode emits only manual_review_required + CVE checks", async () => {
    const r = await performActiveVerification(manualText, {
      verificationMode: "MANUAL_ONLY",
      familyName: "Race / Concurrency",
    });
    const types = r.checks.map((c) => c.type);
    expect(types).toContain("manual_review_required");
    expect(types.some((t) => t.startsWith("github_"))).toBe(false);
    expect(types.some((t) => t.startsWith("poc_"))).toBe(false);
    // CVE pass should still happen — manual_review_required + at least one
    // CVE-related check (verified, fabricated, recent, stale, or api_error).
    const cveTypes = new Set([
      "verified_cve",
      "fabricated_cve",
      "stale_missing_cve",
      "recent_cve_not_yet_published",
      "invalid_cve_year",
      "nvd_api_error",
      "nvd_plagiarism",
    ]);
    expect(types.some((t) => cveTypes.has(t))).toBe(true);
    // Every non-CVE check in MANUAL_ONLY must be the manual hint itself.
    for (const c of r.checks) {
      if (!cveTypes.has(c.type)) {
        expect(c.type).toBe("manual_review_required");
      }
    }
  });

  it("GENERIC mode runs both github_* and poc_* checks", async () => {
    const text = `${sourceCodeText}\n${endpointText}`;
    const r = await performActiveVerification(text, {
      verificationMode: "GENERIC",
    });
    const types = r.checks.map((c) => c.type);
    expect(types.some((t) => t.startsWith("github_"))).toBe(true);
    expect(types.some((t) => t.startsWith("poc_"))).toBe(true);
  });

  it("cache key differs by mode — no cross-mode bleed", async () => {
    // Identical input text exercised under two different modes must yield
    // mode-appropriate check sets. If the cache key did not include the mode,
    // the second call would serve the first call's result and the wrong-mode
    // check types would leak through.
    const sharedText = `
      ${sourceCodeText}
      ${endpointText}
      // Unique-token-${Math.random().toString(36).slice(2)} to keep this isolated from other tests.
    `;

    const sourceFirst = await performActiveVerification(sharedText, {
      verificationMode: "SOURCE_CODE",
    });
    const endpointSecond = await performActiveVerification(sharedText, {
      verificationMode: "ENDPOINT",
    });

    const sourceTypes = sourceFirst.checks.map((c) => c.type);
    const endpointTypes = endpointSecond.checks.map((c) => c.type);

    // SOURCE_CODE call must not produce poc_* checks…
    expect(sourceTypes.some((t) => t.startsWith("poc_"))).toBe(false);
    // …and the subsequent ENDPOINT call must not have been served the
    // SOURCE_CODE-mode cached result (would still lack poc_* if it had).
    expect(endpointTypes.some((t) => t.startsWith("poc_"))).toBe(true);
    expect(endpointTypes.some((t) => t.startsWith("github_"))).toBe(false);
  });

  it("search_fallback github checks are halved and excluded from score/triageNotes", async () => {
    // v3.6.0 §2 guard: when no github.com URL is in the report, the verifier
    // falls back to KNOWN_PROJECTS keyword matches (here, "curl") and tags the
    // resulting checks as `search_fallback`. Those checks must:
    //   1. be down-weighted to ~50% of the referenced_in_report version, and
    //   2. NOT influence the report's score or triage notes.
    // Without this, a wrong project guess could tank a real report's score.
    const refsBlock = "The bug is in src/vtls/handshake.c at line 42.";
    const nonce = Math.random().toString(36).slice(2);

    // Name-only mention → known_project → search_fallback.
    // No version pattern near "curl" so detectProjects keeps it as known_project.
    const fallbackText = `Heap-overflow parsing TLS records.\n${refsBlock}\nTriggered when curl reads the server hello. Unique-${nonce}-a`;

    // Same report but with an explicit repo URL → referenced_in_report.
    // Trailing space (not period) after the URL so the github_url regex
    // captures the slug as `curl/curl`, not `curl/curl.`.
    const referencedText = `Heap-overflow parsing TLS records in https://github.com/curl/curl repo.\n${refsBlock}\nUnique-${nonce}-b`;

    const fallback = await performActiveVerification(fallbackText, {
      verificationMode: "SOURCE_CODE",
    });
    const referenced = await performActiveVerification(referencedText, {
      verificationMode: "SOURCE_CODE",
    });

    const fallbackGh = fallback.checks.filter((c) => c.type.startsWith("github_"));
    const referencedGh = referenced.checks.filter((c) => c.type.startsWith("github_"));

    expect(fallbackGh.length).toBeGreaterThan(0);
    expect(referencedGh.length).toBeGreaterThan(0);
    expect(fallbackGh.every((c) => c.source === "search_fallback")).toBe(true);
    expect(referencedGh.every((c) => c.source === "referenced_in_report")).toBe(true);

    // (1) Each search_fallback check weighs ~50% of its referenced peer.
    for (const fb of fallbackGh) {
      const ref = referencedGh.find((r) => r.type === fb.type && r.target === fb.target);
      expect(ref, `expected referenced peer for ${fb.type}:${fb.target}`).toBeDefined();
      expect(fb.weight).toBe(Math.round(ref!.weight * 0.5));
    }

    // (2) Score and triageNotes match a "github checks stripped" baseline,
    // i.e. the fallback report's outcome is identical to running verification
    // on the same content but without anything that triggers GitHub probes.
    // Building the baseline by removing the project name (no github project
    // detected → no github_* checks at all) is the mechanical equivalent of
    // stripping the search_fallback github checks from the fallback output.
    const strippedText = `Heap-overflow parsing TLS records.\n${refsBlock}\nUnique-${nonce}-c`;
    const stripped = await performActiveVerification(strippedText, {
      verificationMode: "SOURCE_CODE",
    });
    expect(stripped.checks.filter((c) => c.type.startsWith("github_"))).toHaveLength(0);

    // Score is unchanged by the search_fallback checks.
    expect(fallback.score).toBe(stripped.score);

    // Triage notes are unchanged modulo the benign "Report references X"
    // line that is driven purely by detectedProjects (not by any check) and
    // does not put fabrication pressure on the report. Everything else —
    // including the "could not be verified" reviewer pressure — must match.
    const PROJECT_NOTE_PREFIX = "Report references";
    const fbScored = fallback.triageNotes.filter((n) => !n.startsWith(PROJECT_NOTE_PREFIX));
    const stripScored = stripped.triageNotes.filter((n) => !n.startsWith(PROJECT_NOTE_PREFIX));
    expect(fbScored).toEqual(stripScored);

    // Sanity checks: prove the assertions above are non-vacuous by showing
    // the referenced_in_report variant of the same checks DOES move the
    // score and DOES surface the file-path / "could not be verified" notes.
    expect(referenced.score).toBeLessThan(stripped.score);
    const refNotes = referenced.triageNotes.join(" ");
    expect(refNotes).toContain("could not be verified");
    expect(refNotes).toContain("src/vtls/handshake.c");
  });

  it("MANUAL_ONLY cache key differs by familyName", async () => {
    // The MANUAL_ONLY path folds the family name into the cache key because
    // the triage hint copy mentions the family by name. Two MANUAL_ONLY
    // families on identical text must not see each other's hint.
    const text = `Race condition demo unique-${Math.random().toString(36).slice(2)}`;

    const a = await performActiveVerification(text, {
      verificationMode: "MANUAL_ONLY",
      familyName: "Race / Concurrency",
    });
    const b = await performActiveVerification(text, {
      verificationMode: "MANUAL_ONLY",
      familyName: "Request Smuggling",
    });

    const noteA = a.triageNotes.join(" ");
    const noteB = b.triageNotes.join(" ");
    expect(noteA).toContain("Race / Concurrency");
    expect(noteB).toContain("Request Smuggling");
    expect(noteA).not.toContain("Request Smuggling");
    expect(noteB).not.toContain("Race / Concurrency");
  });
});
