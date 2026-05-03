// Sprint 13C (Task #205) — soft-citation regression tests.
//
// A terse legit report ("found a stored xss") names a recognised vulnerability
// class without including the explicit `CWE-79` token. Pre-Task-205 this hit
// the worst-case "vuln type, no CWE" branch (E3 = 38). After Task #205 the
// engine grants a "soft citation" credit (E3 = 60), recovering 22 points for
// experienced researchers using shorthand without rewarding reports that
// don't even name the class.

import { describe, it, expect } from "vitest";
import { runEngine3 } from "./engines";
import {
  extractSignals,
  detectSoftCitation,
  VULN_TYPE_TO_CWE,
} from "./extractors";
import { runEngine3Avri } from "./avri/engine3-avri";
import { classifyReport } from "./avri/classify";
import { FAMILIES_BY_ID } from "./avri/families";

describe("Sprint 13C: soft-citation lookup", () => {
  it("VULN_TYPE_TO_CWE has an entry for every recognised vuln type", () => {
    // Sanity: every name detectSoftCitation could possibly return must map to
    // a numeric CWE id, otherwise the lookup silently misses. Task #301
    // extended the dictionary with XXE, LFI, Open Redirect, Insecure
    // Deserialization, Prototype Pollution, and Command Injection.
    const names = [
      "XSS",
      "SQLi",
      "SSRF",
      "XXE",
      "Buffer Overflow",
      "Use After Free",
      "Path Traversal",
      "LFI",
      "Auth Bypass",
      "CSRF",
      "Open Redirect",
      "Insecure Deserialization",
      "Prototype Pollution",
      "Command Injection",
      "RCE",
      "Info Disclosure",
    ];
    for (const n of names) {
      expect(VULN_TYPE_TO_CWE[n], `missing CWE for ${n}`).toMatch(/^\d+$/);
    }
  });

  it("detectSoftCitation returns the inferred CWE for shorthand prose", () => {
    expect(detectSoftCitation("found a stored xss in comments")).toEqual({
      name: "XSS",
      cweId: "79",
    });
    expect(detectSoftCitation("classic SQLi via the search box")).toEqual({
      name: "SQLi",
      cweId: "89",
    });
    expect(detectSoftCitation("there is an open SSRF on /fetch")).toEqual({
      name: "SSRF",
      cweId: "918",
    });
    expect(detectSoftCitation("classic IDOR on /accounts/:id")).toEqual({
      name: "Auth Bypass",
      cweId: "287",
    });
  });

  // Task #301: explicit per-class shorthand coverage for the new dictionary
  // entries. Each acronym / phrase below comes straight from the kind of terse
  // legit reports the soft-citation tier is meant to recover.
  it("detectSoftCitation recognises XXE shorthand", () => {
    expect(detectSoftCitation("plain XXE in the SOAP endpoint")).toEqual({
      name: "XXE",
      cweId: "611",
    });
    expect(
      detectSoftCitation("xml external entity injection in /upload"),
    ).toEqual({ name: "XXE", cweId: "611" });
  });

  it("detectSoftCitation recognises LFI shorthand", () => {
    expect(detectSoftCitation("found an LFI on ?page=")).toEqual({
      name: "LFI",
      cweId: "98",
    });
    expect(
      detectSoftCitation("local file inclusion via the include param"),
    ).toEqual({ name: "LFI", cweId: "98" });
  });

  it("detectSoftCitation recognises open redirect shorthand", () => {
    expect(detectSoftCitation("trivial open redirect on /login?next=")).toEqual(
      { name: "Open Redirect", cweId: "601" },
    );
    expect(
      detectSoftCitation("classic unvalidated redirect via returnTo"),
    ).toEqual({ name: "Open Redirect", cweId: "601" });
  });

  it("detectSoftCitation recognises insecure deserialization shorthand", () => {
    expect(
      detectSoftCitation("insecure deserialization in the session cookie"),
    ).toEqual({ name: "Insecure Deserialization", cweId: "502" });
    expect(
      detectSoftCitation("Java deserialization via ObjectInputStream"),
    ).toEqual({ name: "Insecure Deserialization", cweId: "502" });
    expect(
      detectSoftCitation("unsafe deserialise of user-controlled YAML"),
    ).toEqual({ name: "Insecure Deserialization", cweId: "502" });
  });

  it("detectSoftCitation recognises prototype pollution shorthand", () => {
    expect(
      detectSoftCitation("prototype pollution via merge() on user input"),
    ).toEqual({ name: "Prototype Pollution", cweId: "1321" });
    expect(
      detectSoftCitation("classic obj.__proto__['polluted']=1 sink"),
    ).toEqual({ name: "Prototype Pollution", cweId: "1321" });
  });

  it("detectSoftCitation recognises standalone command injection (separate from RCE)", () => {
    expect(
      detectSoftCitation("command injection via the filename param"),
    ).toEqual({ name: "Command Injection", cweId: "77" });
    expect(
      detectSoftCitation("classic shell injection on POST /api/exec"),
    ).toEqual({ name: "Command Injection", cweId: "77" });
    // Pre-Task-301 this exact phrase routed through the RCE entry to CWE-78;
    // it must now route to the dedicated Command Injection entry.
    expect(detectSoftCitation("os command injection in /cgi-bin/run")).toEqual({
      name: "Command Injection",
      cweId: "77",
    });
    // RCE shorthand on its own still maps to CWE-78.
    expect(detectSoftCitation("trivial RCE in /api/eval")).toEqual({
      name: "RCE",
      cweId: "78",
    });
  });

  it("detectSoftCitation returns null when no recognised name appears", () => {
    expect(
      detectSoftCitation("just a generic report about software"),
    ).toBeNull();
    expect(
      detectSoftCitation("maybe a clickjacking issue with no x-frame"),
    ).toBeNull();
  });
});

// Task #424: terse vulnerability shorthand in non-English languages.
// Researchers writing in Spanish, Portuguese, French, Russian, or Japanese
// routinely use translated long-form labels alongside the same English
// acronyms, and pre-Task-424 only the English/acronym patterns were honoured,
// so reports omitting the acronym dropped into the underspecified bucket.
// Each test below exercises one foreign-language phrasing per added language
// (ES/PT/FR/RU/JA) covering a different vulnerability class so a regression
// in any single language's regex surfaces here.
describe("Task #424: foreign-language shorthand", () => {
  it("Spanish: 'inyección de comandos' resolves to Command Injection / CWE-77", () => {
    expect(
      detectSoftCitation(
        "encontré una inyección de comandos en el endpoint /run",
      ),
    ).toEqual({
      name: "Command Injection",
      cweId: "77",
    });
  });

  it("Portuguese: 'travessia de diretório' resolves to Path Traversal / CWE-22", () => {
    expect(
      detectSoftCitation(
        "encontrei uma travessia de diretório via o parâmetro file=",
      ),
    ).toEqual({
      name: "Path Traversal",
      cweId: "22",
    });
  });

  it("French: 'inclusion de fichier local' resolves to LFI / CWE-98", () => {
    expect(
      detectSoftCitation("inclusion de fichier local via le paramètre include"),
    ).toEqual({
      name: "LFI",
      cweId: "98",
    });
  });

  it("Russian: 'локальное включение файла' resolves to LFI / CWE-98", () => {
    expect(
      detectSoftCitation(
        "обнаружено локальное включение файла на странице ?page=",
      ),
    ).toEqual({
      name: "LFI",
      cweId: "98",
    });
  });

  it("Japanese: 'コマンドインジェクション' resolves to Command Injection / CWE-77", () => {
    expect(
      detectSoftCitation("/api/run にコマンドインジェクションがあります"),
    ).toEqual({
      name: "Command Injection",
      cweId: "77",
    });
  });

  // End-to-end: a fully foreign-language terse report should clear the
  // soft-citation bar in the legacy E3 engine the same way the equivalent
  // English shorthand does (E3 = 60). Pre-Task-424 this exact text scored
  // ~38 because no VULN_TYPE_PATTERNS regex matched.
  it("Spanish terse report lifts to E3 = 60 with inferred CWE-77", () => {
    const text = "encontré una inyección de comandos en el parámetro filename";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toEqual([]);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "Command Injection", inferredCwe: "CWE-77" },
    });
  });

  // Sanity: foreign-language patterns must not regress the suppression of
  // generic non-vulnerability prose. A Spanish report that doesn't actually
  // name a recognised class should still return null, the same as English.
  it("foreign-language prose with no recognised class still returns null", () => {
    expect(
      detectSoftCitation(
        "creo que su aplicación tiene un problema de seguridad",
      ),
    ).toBeNull();
    expect(
      detectSoftCitation("votre site a peut-être un souci de sécurité"),
    ).toBeNull();
  });
});

// Task #754: terse vulnerability shorthand in the next four researcher
// languages — German, Simplified/Traditional Chinese, Italian, and Korean.
// Same shape as the Task #424 block: one foreign-language phrasing per
// language exercising a different vulnerability class so a regression in
// any single language's regex (or a Han-unification mistake on ZH glyphs)
// surfaces here. A second block re-exercises the soft-citation lift in E3.
describe("Task #754: foreign-language shorthand (DE/ZH/IT/KO)", () => {
  it("German: 'Pufferüberlauf' resolves to Buffer Overflow / CWE-119", () => {
    expect(
      detectSoftCitation(
        "ein Pufferüberlauf in der malloc-Routine ermöglicht RIP-Kontrolle",
      ),
    ).toEqual({
      name: "Buffer Overflow",
      cweId: "119",
    });
  });

  it("German: 'Umgehung der Authentifizierung' resolves to Auth Bypass / CWE-287", () => {
    expect(
      detectSoftCitation(
        "Umgehung der Authentifizierung möglich über manipuliertes JWT",
      ),
    ).toEqual({
      name: "Auth Bypass",
      cweId: "287",
    });
  });

  it("Chinese (Simplified): '命令注入' resolves to Command Injection / CWE-77", () => {
    expect(
      detectSoftCitation("/api/run 接口存在命令注入,可执行任意系统命令"),
    ).toEqual({
      name: "Command Injection",
      cweId: "77",
    });
  });

  it("Chinese (Traditional): '緩衝區溢位' resolves to Buffer Overflow / CWE-119", () => {
    expect(
      detectSoftCitation("在 strcpy 呼叫處發生緩衝區溢位,可覆寫返回位址"),
    ).toEqual({
      name: "Buffer Overflow",
      cweId: "119",
    });
  });

  it("Chinese (Traditional): '遠端程式碼執行' resolves to RCE / CWE-78", () => {
    expect(
      detectSoftCitation("反序列化端點存在遠端程式碼執行漏洞"),
    ).toEqual({
      name: "RCE",
      cweId: "78",
    });
  });

  it("Italian: 'iniezione di comandi' resolves to Command Injection / CWE-77", () => {
    expect(
      detectSoftCitation(
        "ho trovato una iniezione di comandi tramite il parametro cmd=",
      ),
    ).toEqual({
      name: "Command Injection",
      cweId: "77",
    });
  });

  it("Italian: 'deserializzazione non sicura' resolves to Insecure Deserialization / CWE-502", () => {
    expect(
      detectSoftCitation(
        "il payload pickle innesca una deserializzazione non sicura",
      ),
    ).toEqual({
      name: "Insecure Deserialization",
      cweId: "502",
    });
  });

  it("Korean: '원격 코드 실행' resolves to RCE / CWE-78", () => {
    expect(
      detectSoftCitation("/api/eval 엔드포인트에서 원격 코드 실행 가능"),
    ).toEqual({
      name: "RCE",
      cweId: "78",
    });
  });

  it("Korean: '경로 탐색' resolves to Path Traversal / CWE-22", () => {
    expect(
      detectSoftCitation("file= 파라미터를 통한 경로 탐색 발견"),
    ).toEqual({
      name: "Path Traversal",
      cweId: "22",
    });
  });

  // End-to-end: a fully German terse report should clear the soft-citation
  // bar in legacy E3 the same way the equivalent English shorthand does
  // (E3 = 60). Mirrors the analogous Task #424 Spanish lift test so the
  // two new-language batches share the same regression coverage.
  it("German terse report lifts to E3 = 60 with inferred CWE-77", () => {
    const text = "eine Befehlsinjektion über den filename-Parameter gefunden";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toEqual([]);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "Command Injection", inferredCwe: "CWE-77" },
    });
  });

  // Sanity: the new-language patterns must not regress the suppression of
  // generic non-vulnerability prose. A German/Chinese/Italian/Korean
  // report that doesn't actually name a recognised class should still
  // return null, the same as English and the Task #424 languages.
  it("DE/ZH/IT/KO prose with no recognised class still returns null", () => {
    expect(
      detectSoftCitation("ich glaube Ihre Anwendung hat ein Sicherheitsproblem"),
    ).toBeNull();
    expect(detectSoftCitation("我觉得你们的应用有安全问题")).toBeNull();
    expect(
      detectSoftCitation("penso che la vostra applicazione abbia un problema"),
    ).toBeNull();
    expect(detectSoftCitation("귀사의 애플리케이션에 보안 문제가 있는 것 같습니다")).toBeNull();
  });
});

describe("Sprint 13C: legacy E3 soft-citation tier", () => {
  it("terse XSS report (no CWE token) lifts to E3 = 60", () => {
    const text = "found a stored xss in the comments section";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toEqual([]);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    const softCite = r.triggeredIndicators.find(
      (i) => i.signal === "SOFT_CITATION",
    );
    expect(softCite, "expected SOFT_CITATION indicator").toBeDefined();
    expect(softCite!.value).toMatch(/XSS .* CWE-79/);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "XSS", inferredCwe: "CWE-79" },
    });
  });

  it("terse SQLi shorthand also lifts to E3 = 60", () => {
    const text = "noticed SQLi on the login form parameter `username`";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
  });

  // Task #301: end-to-end coverage that the soft-citation tier also lifts
  // for the newly recognised shorthand. We pick one class per major mapping
  // path (WEB_CLIENT, INJECTION, DESERIALIZATION) so a regression in any of
  // those branches surfaces in the legacy engine.
  it("terse XXE shorthand lifts to E3 = 60 with inferred CWE-611", () => {
    const text = "found a plain XXE in the SOAP /api/quote endpoint";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toEqual([]);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "XXE", inferredCwe: "CWE-611" },
    });
  });

  it("terse open redirect shorthand lifts to E3 = 60 with inferred CWE-601", () => {
    const text = "trivial open redirect on /login?next= via Location header";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "Open Redirect", inferredCwe: "CWE-601" },
    });
  });

  it("terse insecure deserialization shorthand lifts to E3 = 60 with inferred CWE-502", () => {
    const text = "insecure deserialization in the session cookie value";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: {
        name: "Insecure Deserialization",
        inferredCwe: "CWE-502",
      },
    });
  });

  it("terse standalone command injection shorthand lifts to E3 = 60 with inferred CWE-77 (not RCE/CWE-78)", () => {
    const text = "classic command injection via the filename parameter";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "Command Injection", inferredCwe: "CWE-77" },
    });
  });

  it("explicit CWE citation is unchanged (per-CWE fingerprint scoring still wins)", () => {
    // Same report content but with the CWE token added — should still go
    // through the per-CWE fingerprint path, not the soft-citation path.
    const text =
      "Reflected XSS (CWE-79) via the q parameter, payload <script>alert(1)</script>";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toContain("CWE-79");
    const r = runEngine3(signals, text);
    // Per-CWE fingerprint scoring; not the SOFT_CITATION constant.
    expect(
      r.triggeredIndicators.some((i) => i.signal === "SOFT_CITATION"),
    ).toBe(false);
    expect(r.signalBreakdown).toHaveProperty("perCWEScores");
  });

  it("no CWE and no recognised name still defaults to 42", () => {
    const text =
      "I think the way you handle errors is bad and could be exploited.";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(42);
    expect(
      r.triggeredIndicators.some((i) => i.signal === "SOFT_CITATION"),
    ).toBe(false);
    expect(
      r.triggeredIndicators.some((i) => i.signal === "NO_CWE_CLAIMED"),
    ).toBe(true);
  });
});

describe("Sprint 13C: AVRI E3 soft-citation tier", () => {
  it("terse XSS report uses SOFT_CITATION baseRule with baseScore=60", () => {
    const text = "found a stored xss in the comments section";
    const signals = extractSignals(text);
    const classification = classifyReport(text, signals.claimedCwes);
    const family = FAMILIES_BY_ID[classification.family.id];
    const result = runEngine3Avri(signals, text, family, classification);
    const breakdown = result.engine.signalBreakdown as Record<string, unknown>;
    const avri = breakdown.avri as {
      baseRule: string;
      baseScore: number;
      softCitation: { name: string; inferredCwe: string } | null;
    };
    // Soft citation lifts the base from the suppressed 32/38 tier to 60.
    expect(avri.baseRule).toBe("SOFT_CITATION");
    expect(avri.baseScore).toBe(60);
    expect(avri.softCitation).toEqual({ name: "XSS", inferredCwe: "CWE-79" });
    // Blended score may be reduced by orthogonal coherence checks (e.g. lack
    // of browser/payload tooling for WEB_CLIENT). The contract is that the
    // score recovers substantially above the pre-Task-205 ~38 baseline, not
    // that coherence is suppressed.
    expect(result.engine.score).toBeGreaterThan(45);
    expect(
      result.engine.triggeredIndicators.some(
        (i) => i.signal === "SOFT_CITATION",
      ),
    ).toBe(true);
  });

  it("SOFT_CITATION does not fire when an explicit CWE is cited", () => {
    const text =
      "Reflected XSS (CWE-79) via the q parameter, payload <script>alert(1)</script>";
    const signals = extractSignals(text);
    const classification = classifyReport(text, signals.claimedCwes);
    const family = FAMILIES_BY_ID[classification.family.id];
    const result = runEngine3Avri(signals, text, family, classification);
    const breakdown = result.engine.signalBreakdown as Record<string, unknown>;
    const avri = breakdown.avri as { baseRule: string };
    expect(avri.baseRule).not.toBe("SOFT_CITATION");
    expect(
      result.engine.triggeredIndicators.some(
        (i) => i.signal === "SOFT_CITATION",
      ),
    ).toBe(false);
  });
});
