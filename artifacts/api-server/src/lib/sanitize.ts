const MAX_INPUT_LENGTH = 5 * 1024 * 1024;
const MAX_ANALYSIS_LENGTH = 50_000;

export function sanitizeText(input: string): string {
  let text = input;

  if (text.length > MAX_INPUT_LENGTH) {
    text = text.slice(0, MAX_INPUT_LENGTH);
  }

  text = text.replace(/<script[\s\S]*?<\/script>/gi, "[removed-script]");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "[removed-style]");
  text = text.replace(/on\w+\s*=\s*["'][^"']*["']/gi, "[removed-event-handler]");
  text = text.replace(/javascript\s*:/gi, "[removed-js-uri]");
  text = text.replace(/data\s*:\s*text\/html/gi, "[removed-data-uri]");

  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  text = text.replace(/\0/g, "");

  text = text.replace(/[ \t]{20,}/g, "                    ");
  text = text.replace(/(\r?\n){10,}/g, "\n\n\n\n\n");

  return text.trim();
}

export function sanitizeForAnalysis(input: string): string {
  if (!input || typeof input !== "string") return "";

  let text = input;

  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  try {
    text = text.normalize("NFC");
  } catch {
    text = text.replace(/[^\x20-\x7E\n\r\t]/g, " ");
  }

  if (text.length > MAX_ANALYSIS_LENGTH) {
    text = text.substring(0, MAX_ANALYSIS_LENGTH);
  }

  return text;
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[^\w\s\-\.]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .substring(0, 255);
}

export function detectBinaryContent(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8192);
  let nullCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) nullCount++;
  }
  return nullCount / sampleSize > 0.1;
}

