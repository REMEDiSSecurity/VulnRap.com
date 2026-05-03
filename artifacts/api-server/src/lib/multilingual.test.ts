import { describe, it, expect } from "vitest";
import {
  FIXTURES,
  ENGLISH_LEGIT,
  ENGLISH_SLOP,
  TIER_ORDER,
  tierIndex,
  type Language,
} from "./multilingual-fixtures.js";
import {
  classifyTierForText,
  computePerLanguageAgreement,
} from "./multilingual-agreement.js";

const LANGUAGES: Language[] = ["es", "de", "ja", "ru", "pt", "ar"];

describe("Multilingual input test battery", () => {
  it("ships exactly 12 fixtures: 2 per language across 6 languages", () => {
    expect(FIXTURES).toHaveLength(12);
    const byLang = new Map<Language, Set<string>>();
    for (const f of FIXTURES) {
      const set = byLang.get(f.language) ?? new Set<string>();
      set.add(f.variant);
      byLang.set(f.language, set);
    }
    for (const lang of LANGUAGES) {
      const variants = byLang.get(lang);
      expect(variants, `missing language ${lang}`).toBeDefined();
      expect(variants!.has("legit")).toBe(true);
      expect(variants!.has("slop")).toBe(true);
    }
  });

  describe("per-language tier classification within ±1 tier of English original", () => {
    const englishLegitTier = classifyTierForText(ENGLISH_LEGIT);
    const englishSlopTier = classifyTierForText(ENGLISH_SLOP);
    const englishLegitIdx = tierIndex(englishLegitTier);
    const englishSlopIdx = tierIndex(englishSlopTier);

    for (const lang of LANGUAGES) {
      const legitFx = FIXTURES.find(f => f.language === lang && f.variant === "legit")!;
      const slopFx = FIXTURES.find(f => f.language === lang && f.variant === "slop")!;

      it(`${lang}: legit fixture tier within ±1 of English legit (${englishLegitTier})`, () => {
        const tier = classifyTierForText(legitFx.text);
        const idx = tierIndex(tier);
        expect(idx, `unknown tier '${tier}' for ${lang}-legit`).toBeGreaterThanOrEqual(0);
        expect(Math.abs(idx - englishLegitIdx)).toBeLessThanOrEqual(1);
      });

      it(`${lang}: slop fixture tier within ±1 of English slop (${englishSlopTier})`, () => {
        const tier = classifyTierForText(slopFx.text);
        const idx = tierIndex(tier);
        expect(idx, `unknown tier '${tier}' for ${lang}-slop`).toBeGreaterThanOrEqual(0);
        expect(Math.abs(idx - englishSlopIdx)).toBeLessThanOrEqual(1);
      });
    }
  });

  describe("computePerLanguageAgreement", () => {
    it("returns one entry per language with deltas and an aggregate agreement rate", () => {
      const report = computePerLanguageAgreement();
      expect(report.fixtureCount).toBe(12);
      expect(report.perLanguage).toHaveLength(6);

      const langs = report.perLanguage.map(p => p.language).sort();
      expect(langs).toEqual([...LANGUAGES].sort());

      for (const entry of report.perLanguage) {
        expect(TIER_ORDER).toContain(entry.legitTier as typeof TIER_ORDER[number]);
        expect(TIER_ORDER).toContain(entry.slopTier as typeof TIER_ORDER[number]);
        expect(entry.legitAgrees).toBe(Math.abs(entry.legitTierDelta) <= 1);
        expect(entry.slopAgrees).toBe(Math.abs(entry.slopTierDelta) <= 1);
      }

      expect(report.agreementRate).toBeGreaterThanOrEqual(0);
      expect(report.agreementRate).toBeLessThanOrEqual(100);
    });

    it("does not block: it surfaces disparities rather than throwing on them", () => {
      const report = computePerLanguageAgreement(0);
      expect(typeof report.agreementRate).toBe("number");
      expect(report).toHaveProperty("englishLegitTier");
      expect(report).toHaveProperty("englishSlopTier");
    });
  });
});
