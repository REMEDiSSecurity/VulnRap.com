const STORAGE_KEY = "vulnrap_history";
const MAX_ENTRIES = 100;

export interface HistoryEntry {
  id: number;
  reportCode: string;
  slopScore: number;
  slopTier: string;
  matchCount: number;
  contentMode: string;
  fileName: string | null;
  timestamp: string;
  type: "submit" | "check";
  reconstructed?: boolean;
}

export function getHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addHistoryEntry(entry: HistoryEntry): void {
  try {
    const history = getHistory();
    const exists = history.findIndex(
      (h) => h.id === entry.id && h.type === entry.type
    );
    if (exists >= 0) {
      history[exists] = entry;
    } else {
      history.unshift(entry);
    }
    if (history.length > MAX_ENTRIES) {
      history.length = MAX_ENTRIES;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {}
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function markHistoryEntryReconstructed(id: number, type: "submit" | "check", reconstructed: boolean): void {
  try {
    const history = getHistory();
    const idx = history.findIndex((h) => h.id === id && h.type === type);
    if (idx < 0) return;
    if ((history[idx].reconstructed ?? false) === reconstructed) return;
    history[idx] = { ...history[idx], reconstructed };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {}
}

export function removeHistoryEntry(id: number, type: "submit" | "check"): void {
  try {
    const history = getHistory().filter(
      (h) => !(h.id === id && h.type === type)
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {}
}
