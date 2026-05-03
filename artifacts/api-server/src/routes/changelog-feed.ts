// Task #711 — Changelog RSS feed.
//
// Serves an RFC 4287-compliant Atom feed at GET /changelog/feed.xml that
// mirrors the version entries rendered by `artifacts/vulnrap/src/pages/changelog.tsx`.
// To avoid duplicating changelog content, the route parses changelog.tsx at
// boot time and extracts each version's structured data (version, date,
// label, sections with title/type/items as plain text). Icons and JSX styling
// are intentionally discarded — the feed is text-only.
//
// Mounted at the app root (not under /api) in app.ts so the public path
// `/changelog/feed.xml` matches the auto-discovery <link rel="alternate">
// injected into the changelog page head.
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { Router, type IRouter, type Request } from "express";
import { buildPublicUrl } from "../lib/public-url";

const router: IRouter = Router();

const CHANGELOG_TSX_CANDIDATES = [
  process.env.CHANGELOG_TSX_PATH,
  path.resolve(process.cwd(), "artifacts/vulnrap/src/pages/changelog.tsx"),
  path.resolve(process.cwd(), "../vulnrap/src/pages/changelog.tsx"),
  path.resolve(process.cwd(), "src/pages/changelog.tsx"),
].filter((p): p is string => !!p);

function resolveChangelogPath(): string {
  for (const candidate of CHANGELOG_TSX_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[changelog-feed] Could not find changelog.tsx. Tried: ${CHANGELOG_TSX_CANDIDATES.join(", ")}`,
  );
}

export interface ChangelogFeedSection {
  title: string;
  type: string;
  items: string[];
}

export interface ChangelogFeedEntry {
  version: string;
  date: string;
  label: string;
  sections: ChangelogFeedSection[];
}

// Walk a TS string literal beginning at text[i] === '"', returning the
// decoded string and the index just past the closing quote. Handles the
// JS escape sequences the changelog actually uses (\", \\, \n, \t, \r).
function readStringLiteral(text: string, start: number): [string, number] {
  if (text[start] !== '"') {
    throw new Error(`[changelog-feed] Expected '"' at offset ${start}`);
  }
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "'":
          out += "'";
          break;
        default:
          out += next ?? "";
          break;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return [out, i + 1];
    out += ch;
    i++;
  }
  throw new Error(`[changelog-feed] Unterminated string starting at ${start}`);
}

// Walk forward from `text[start]` (which must be '[' or '{') and return the
// index of the matching closing bracket, respecting nested brackets and
// string literals. Used to slice out section / item array bodies without
// running into ']' that appear inside item strings.
function findMatchingBracket(text: string, start: number): number {
  const open = text[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : null;
  if (!close) {
    throw new Error(`[changelog-feed] Expected '[' or '{' at offset ${start}`);
  }
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const [, next] = readStringLiteral(text, i);
      i = next;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(`[changelog-feed] Unmatched '${open}' at offset ${start}`);
}

// Extract every "..." string literal that appears at the top level of `body`
// (i.e. not nested inside another bracketed expression). For an items: [...]
// body, that is exactly the list of item strings.
function extractItemStrings(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      const [str, next] = readStringLiteral(body, i);
      if (depth === 0) out.push(str);
      i = next;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    else if (ch === "]" || ch === "}" || ch === ")") depth--;
    i++;
  }
  return out;
}

const KEY_VALUE_STRING_RE = (key: string) => new RegExp(`\\b${key}\\s*:\\s*"`);

// Parse a single section object body (text between `{` and `}` of one
// section literal). Returns title/type/items, or null if the shape is
// unexpected.
function parseSection(body: string): ChangelogFeedSection | null {
  const titleMatch = KEY_VALUE_STRING_RE("title").exec(body);
  const typeMatch = KEY_VALUE_STRING_RE("type").exec(body);
  if (!titleMatch || !typeMatch) return null;
  const titleStart = titleMatch.index + titleMatch[0].length - 1;
  const [title] = readStringLiteral(body, titleStart);
  const typeStart = typeMatch.index + typeMatch[0].length - 1;
  const [type] = readStringLiteral(body, typeStart);

  const itemsKey = /\bitems\s*:\s*\[/.exec(body);
  if (!itemsKey) return { title, type, items: [] };
  const arrStart = itemsKey.index + itemsKey[0].length - 1;
  const arrEnd = findMatchingBracket(body, arrStart);
  const arrBody = body.slice(arrStart + 1, arrEnd);
  const items = extractItemStrings(arrBody);
  return { title, type, items };
}

// Split a sections-array body into individual section object bodies by
// walking top-level `{...}` literals.
function splitSectionObjects(arrBody: string): string[] {
  const sections: string[] = [];
  let i = 0;
  while (i < arrBody.length) {
    const ch = arrBody[i];
    if (ch === "{") {
      const end = findMatchingBracket(arrBody, i);
      sections.push(arrBody.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return sections;
}

export function parseChangelogTsx(text: string): ChangelogFeedEntry[] {
  // Anchor on each version: "..." occurrence — the only place that string
  // appears is as a top-level entry key, so this is a reliable cut point.
  const entries: ChangelogFeedEntry[] = [];
  const versionRe =
    /\bversion:\s*"([^"]+)"\s*,\s*\n\s*date:\s*"([^"]+)"\s*,\s*\n\s*label:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = versionRe.exec(text)) !== null) {
    const [, version, date, labelRaw] = m;
    const label = labelRaw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    // Find the sections: [ ... ] block that follows.
    const after = text.slice(m.index);
    const sectionsKey = /\bsections\s*:\s*\[/.exec(after);
    if (!sectionsKey) continue;
    const arrStart = m.index + sectionsKey.index + sectionsKey[0].length - 1;
    const arrEnd = findMatchingBracket(text, arrStart);
    const arrBody = text.slice(arrStart + 1, arrEnd);
    const sectionBodies = splitSectionObjects(arrBody);
    const sections = sectionBodies
      .map(parseSection)
      .filter((s): s is ChangelogFeedSection => s !== null);
    entries.push({ version, date, label, sections });
  }
  return entries;
}

interface CachedFeed {
  mtimeMs: number;
  entries: ChangelogFeedEntry[];
}

let cached: CachedFeed | null = null;

export function loadChangelogEntries(): ChangelogFeedEntry[] {
  const file = resolveChangelogPath();
  const stat = statSync(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries;
  const text = readFileSync(file, "utf8");
  const entries = parseChangelogTsx(text);
  cached = { mtimeMs: stat.mtimeMs, entries };
  return entries;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function entryUpdated(date: string): string {
  // Treat YYYY-MM-DD as UTC midnight; RFC 3339.
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return new Date(0).toISOString();
  return d.toISOString();
}

// Minimal HTML escape — only the three characters that have structural
// meaning in HTML element content. Quotes are safe inside element content
// and are intentionally left untouched here because the HTML payload is
// wrapped in an XML CDATA block downstream, so a second round of XML
// escaping is not applied.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildEntryHtml(entry: ChangelogFeedEntry): string {
  const parts: string[] = [];
  for (const section of entry.sections) {
    parts.push(
      `<h3>${escapeHtml(section.title)} <em>(${escapeHtml(section.type)})</em></h3>`,
    );
    if (section.items.length > 0) {
      parts.push("<ul>");
      for (const item of section.items) {
        parts.push(`<li>${escapeHtml(item)}</li>`);
      }
      parts.push("</ul>");
    }
  }
  return parts.join("");
}

// Wrap arbitrary HTML in a CDATA block, splitting any literal ']]>'
// sequence the content might contain so the CDATA section terminates
// only where intended.
function wrapCdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function buildEntrySummary(entry: ChangelogFeedEntry): string {
  // Plain-text summary: first item of first section, capped at 280 chars.
  const first = entry.sections[0]?.items[0] ?? entry.label;
  return first.length > 280 ? first.slice(0, 277) + "…" : first;
}

export function buildAtomFeed(
  entries: ChangelogFeedEntry[],
  baseUrl: string,
): string {
  const feedSelf = `${baseUrl}/changelog/feed.xml`;
  const changelogUrl = `${baseUrl}/changelog`;
  const updated = entries[0]
    ? entryUpdated(entries[0].date)
    : new Date(0).toISOString();
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>VulnRap Changelog</title>`,
    `  <subtitle>Every feature, fix, and improvement shipped to VulnRap.</subtitle>`,
    `  <id>${escapeXml(changelogUrl)}</id>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(changelogUrl)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedSelf)}"/>`,
    `  <updated>${updated}</updated>`,
    `  <author><name>VulnRap</name></author>`,
  ];
  for (const entry of entries) {
    const id = `${changelogUrl}#v${entry.version}`;
    const title = `v${entry.version} — ${entry.label}`;
    const html = buildEntryHtml(entry);
    const summary = buildEntrySummary(entry);
    lines.push("  <entry>");
    lines.push(`    <id>${escapeXml(id)}</id>`);
    lines.push(`    <title>${escapeXml(title)}</title>`);
    lines.push(
      `    <link rel="alternate" type="text/html" href="${escapeXml(id)}"/>`,
    );
    lines.push(`    <updated>${entryUpdated(entry.date)}</updated>`);
    lines.push(`    <published>${entryUpdated(entry.date)}</published>`);
    lines.push(`    <summary type="text">${escapeXml(summary)}</summary>`);
    lines.push(`    <content type="html">${wrapCdata(html)}</content>`);
    lines.push("  </entry>");
  }
  lines.push("</feed>");
  return lines.join("\n");
}

router.get("/changelog/feed.xml", (req: Request, res) => {
  try {
    const entries = loadChangelogEntries();
    const baseUrl = buildPublicUrl({ req }).replace(/\/$/, "");
    const xml = buildAtomFeed(entries, baseUrl);
    res.set("Cache-Control", "public, max-age=600, stale-while-revalidate=600");
    res.type("application/atom+xml; charset=utf-8").send(xml);
  } catch (err) {
    res
      .status(500)
      .type("application/atom+xml; charset=utf-8")
      .send(
        `<?xml version="1.0" encoding="utf-8"?>\n<error>${escapeXml(
          (err as Error).message,
        )}</error>`,
      );
  }
});

export default router;
