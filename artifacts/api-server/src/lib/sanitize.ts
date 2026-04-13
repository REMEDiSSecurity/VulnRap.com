const MAX_INPUT_LENGTH = 5 * 1024 * 1024;

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

export function safeJsonParse<T = unknown>(input: string): T | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object") return parsed as T;
    if (Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      delete parsed.__proto__;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "constructor")) {
      delete parsed.constructor;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "prototype")) {
      delete parsed.prototype;
    }
    return parsed as T;
  } catch {
    return null;
  }
}
