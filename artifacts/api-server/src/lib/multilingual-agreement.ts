import { analyzeLinguistic } from "./linguistic-analysis.js";
import { analyzeFactual } from "./factual-verification.js";
import { analyzeSloppiness } from "./sloppiness.js";
import { fuseScores, getSlopTier } from "./score-fusion.js";
import {
  ENGLISH_LEGIT,
  ENGLISH_SLOP,
  FIXTURES,
  tierIndex,
  type Language,
  type Variant,
} from "./multilingual-fixtures.js";

export interface PerLanguageAgreement {
  language: Language;
  legitTier: string;
  slopTier: string;
  legitTierDelta: number;
  slopTierDelta: number;
  legitAgrees: boolean;
  slopAgrees: boolean;
}

export interface PerLanguageAgreementReport {
  englishLegitTier: string;
  englishSlopTier: string;
  perLanguage: PerLanguageAgreement[];
  agreementRate: number;
  fixtureCount: number;
}

function classifyTier(text: string): string {
  const linguistic = analyzeLinguistic(text);
  const factual = analyzeFactual(text);
  const heuristic = analyzeSloppiness(text);
  const fusion = fuseScores(linguistic, factual, null, heuristic.qualityScore, text);
  return fusion.slopTier;
}

export function classifyTierForText(text: string): string {
  return classifyTier(text);
}

export function computePerLanguageAgreement(
  toleranceTiers = 1
): PerLanguageAgreementReport {
  const englishLegitTier = classifyTier(ENGLISH_LEGIT);
  const englishSlopTier = classifyTier(ENGLISH_SLOP);
  const englishLegitIdx = tierIndex(englishLegitTier);
  const englishSlopIdx = tierIndex(englishSlopTier);

  const byLanguage = new Map<Language, { legit?: string; slop?: string }>();
  for (const f of FIXTURES) {
    const entry = byLanguage.get(f.language) ?? {};
    const tier = classifyTier(f.text);
    if (f.variant === "legit") entry.legit = tier;
    else entry.slop = tier;
    byLanguage.set(f.language, entry);
  }

  const perLanguage: PerLanguageAgreement[] = [];
  let agreeCount = 0;
  let totalCount = 0;

  for (const [language, tiers] of byLanguage) {
    const legitTier = tiers.legit ?? "Clean";
    const slopTier = tiers.slop ?? "Clean";
    const legitDelta = tierIndex(legitTier) - englishLegitIdx;
    const slopDelta = tierIndex(slopTier) - englishSlopIdx;
    const legitAgrees = Math.abs(legitDelta) <= toleranceTiers;
    const slopAgrees = Math.abs(slopDelta) <= toleranceTiers;
    if (legitAgrees) agreeCount++;
    if (slopAgrees) agreeCount++;
    totalCount += 2;
    perLanguage.push({
      language,
      legitTier,
      slopTier,
      legitTierDelta: legitDelta,
      slopTierDelta: slopDelta,
      legitAgrees,
      slopAgrees,
    });
  }

  perLanguage.sort((a, b) => a.language.localeCompare(b.language));

  const agreementRate =
    totalCount === 0 ? 0 : Math.round((agreeCount / totalCount) * 1000) / 10;

  return {
    englishLegitTier,
    englishSlopTier,
    perLanguage,
    agreementRate,
    fixtureCount: totalCount,
  };
}

export type { Language, Variant };
