// Task #710 — Validate the static `public/robots.txt` is well-formed
// and disallows every reviewer-only route for *every* declared user
// agent group. The per-group assertion matters because the standard
// robots.txt resolution rule (used by Googlebot, Bingbot, GPTBot, etc.)
// picks the most-specific matching group and ignores `User-agent: *`
// when a more-specific group exists. A `Disallow` only under the
// wildcard group would therefore be silently overridden for every
// explicitly named bot.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROBOTS = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "public", "robots.txt"),
  "utf8",
);

const REVIEWER_ONLY_PATHS = ["/feedback-analytics", "/audit-log"];

interface RobotsGroup {
  userAgents: string[];
  allow: string[];
  disallow: string[];
}

// Minimal robots.txt parser modelled on the resolution Googlebot
// performs: contiguous `User-agent` lines start a group; subsequent
// `Allow` / `Disallow` lines belong to that group until the next
// `User-agent` line or a `Sitemap` line. Comments and blank lines act
// only as separators between groups when they break a contiguous run
// of `User-agent` lines.
function parseRobots(txt: string): {
  groups: RobotsGroup[];
  sitemaps: string[];
} {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasUserAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") {
      lastWasUserAgent = false;
      continue;
    }
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const directive = m[1].toLowerCase();
    const value = m[2].trim();
    if (directive === "sitemap") {
      sitemaps.push(value);
      lastWasUserAgent = false;
      continue;
    }
    if (directive === "user-agent") {
      if (!current || !lastWasUserAgent) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
      lastWasUserAgent = true;
      continue;
    }
    lastWasUserAgent = false;
    if (!current) continue;
    if (directive === "allow") current.allow.push(value);
    else if (directive === "disallow") current.disallow.push(value);
  }
  return { groups, sitemaps };
}

const PARSED = parseRobots(ROBOTS);

describe("public/robots.txt", () => {
  it("declares a User-agent: * group", () => {
    const wildcard = PARSED.groups.find((g) => g.userAgents.includes("*"));
    expect(wildcard).toBeDefined();
  });

  it("references the canonical sitemap URL", () => {
    expect(PARSED.sitemaps).toContain("https://vulnrap.com/sitemap.xml");
  });

  it("only uses recognised directives", () => {
    const directiveLines = ROBOTS.split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0);
    const allowed = /^(User-agent|Allow|Disallow|Sitemap|Crawl-delay):\s*\S/i;
    for (const line of directiveLines) {
      expect(line).toMatch(allowed);
    }
  });

  it("declares more than just the wildcard group (sanity check)", () => {
    const explicit = PARSED.groups.filter((g) => !g.userAgents.includes("*"));
    expect(explicit.length).toBeGreaterThan(5);
  });

  // Per-group enforcement is the meat of this test. Standard robots
  // resolution picks the *most specific* matching group, so a Disallow
  // only under `User-agent: *` would not apply to Googlebot/Bingbot/
  // GPTBot/etc. Every declared group must repeat the disallow rules.
  it.each(REVIEWER_ONLY_PATHS)(
    "every declared User-agent group disallows %s",
    (reviewerPath) => {
      const offenders: string[] = [];
      for (const group of PARSED.groups) {
        if (!group.disallow.includes(reviewerPath)) {
          offenders.push(group.userAgents.join(","));
        }
      }
      expect(
        offenders,
        `Groups missing Disallow ${reviewerPath}: ${offenders.join(" | ")}`,
      ).toEqual([]);
    },
  );

  it("does not Allow a reviewer-only path in any group (would defeat Disallow)", () => {
    for (const group of PARSED.groups) {
      for (const reviewerPath of REVIEWER_ONLY_PATHS) {
        expect(group.allow).not.toContain(reviewerPath);
      }
    }
  });
});
