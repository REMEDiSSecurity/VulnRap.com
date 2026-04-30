import { getSettings, getSlopColorCustom, getSlopProgressColorCustom } from "@/lib/settings";

export function getSlopColor(score: number) {
  const s = getSettings();
  return getSlopColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

export function getSlopProgressColor(score: number) {
  const s = getSettings();
  return getSlopProgressColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

export function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 5 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf"];

export function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some((e) => ext.endsWith(e));
  if (!hasValidExt) {
    return `Unsupported file type. Accepted formats: .txt, .md, .pdf`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 5MB.`;
  }
  if (file.size === 0) {
    return "File is empty. Please select a file with content.";
  }
  return null;
}

export type InputMode = "file" | "text" | "link";
export type UploadStage = "idle" | "uploading" | "analyzing" | "done" | "error";
