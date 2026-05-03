import en from "@/locales/en.json";

export type TranslationKey = keyof typeof en;

const catalog: Record<string, string> = en as Record<string, string>;

export function t(key: TranslationKey): string {
  const value = catalog[key];
  if (value === undefined) {
    if (typeof console !== "undefined") {
      console.warn(`[i18n] Missing translation key: ${key}`);
    }
    return key;
  }
  return value;
}

export function useT(): (key: TranslationKey) => string {
  return t;
}
