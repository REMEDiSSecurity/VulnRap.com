export function sanitizeText(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\0/g, "")
    .trim();
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[^\w\s\-\.]/g, "")
    .replace(/\.{2,}/g, ".")
    .substring(0, 255);
}
