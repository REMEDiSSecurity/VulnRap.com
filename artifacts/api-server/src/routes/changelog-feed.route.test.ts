// Task #711 — Unit + smoke tests for the changelog Atom feed.
//
// Exercises the parser against (a) a hand-rolled changelog snippet that
// covers the awkward shapes (escaped quotes, ']' inside item text, multiple
// sections, multiple entries) and (b) the real changelog.tsx so a future
// edit that breaks the format trips the test instead of silently shipping
// an empty feed. Then validates buildAtomFeed produces well-formed XML
// with the required Atom elements and one <entry> per parsed version.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  parseChangelogTsx,
  buildAtomFeed,
  loadChangelogEntries,
} from "./changelog-feed";

const SYNTH = `
const CHANGELOG = [
  {
    version: "9.9.9",
    date: "2026-05-03",
    label: "Synth — quotes \\"and\\" brackets",
    labelColor: "border-violet-500",
    sections: [
      {
        icon: <Foo className="w-4 h-4" />,
        title: "First section",
        type: "feature",
        items: [
          "item one with ] bracket inside",
          "item two with \\"escaped quotes\\"",
        ],
      },
      {
        icon: <Bar className="w-4" />,
        title: "Second section",
        type: "fix",
        items: [
          "single item",
        ],
      },
    ],
  },
  {
    version: "9.9.8",
    date: "2026-05-01",
    label: "Older entry",
    labelColor: "border-cyan-500",
    sections: [
      {
        icon: <Baz />,
        title: "Lone section",
        type: "improvement",
        items: ["only item"],
      },
    ],
  },
];
`;

describe("parseChangelogTsx", () => {
  it("parses entries, sections, and items including escaped quotes and inline brackets", () => {
    const entries = parseChangelogTsx(SYNTH);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      version: "9.9.9",
      date: "2026-05-03",
      label: 'Synth — quotes "and" brackets',
    });
    expect(entries[0].sections).toHaveLength(2);
    expect(entries[0].sections[0]).toMatchObject({
      title: "First section",
      type: "feature",
    });
    expect(entries[0].sections[0].items).toEqual([
      "item one with ] bracket inside",
      'item two with "escaped quotes"',
    ]);
    expect(entries[0].sections[1].items).toEqual(["single item"]);
    expect(entries[1]).toMatchObject({
      version: "9.9.8",
      date: "2026-05-01",
      label: "Older entry",
    });
    expect(entries[1].sections[0].items).toEqual(["only item"]);
  });

  it("parses the real changelog.tsx and returns at least one entry per documented version", () => {
    const candidates = [
      path.resolve(process.cwd(), "artifacts/vulnrap/src/pages/changelog.tsx"),
      path.resolve(process.cwd(), "../vulnrap/src/pages/changelog.tsx"),
    ];
    const file = candidates.find((c) => {
      try { readFileSync(c); return true; } catch { return false; }
    });
    if (!file) throw new Error(`changelog.tsx not found, tried: ${candidates.join(", ")}`);
    const text = readFileSync(file, "utf8");
    const entries = parseChangelogTsx(text);
    // The current page has 17 versions (1.0.0 → 3.10.0). Allow growth but
    // refuse to silently regress to 0 / a tiny number.
    expect(entries.length).toBeGreaterThanOrEqual(15);
    // First entry is the newest in the array (3.10.0 at time of writing).
    expect(entries[0].version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entries[0].sections.length).toBeGreaterThan(0);
    expect(entries[0].sections[0].items.length).toBeGreaterThan(0);
    // No empty sections (would mean the items parser misfired).
    for (const e of entries) {
      for (const s of e.sections) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(["feature", "fix", "security", "improvement"]).toContain(s.type);
      }
    }
  });
});

describe("loadChangelogEntries", () => {
  it("loads from the real file and caches by mtime", () => {
    const a = loadChangelogEntries();
    const b = loadChangelogEntries();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("buildAtomFeed", () => {
  it("produces a well-formed Atom feed with one <entry> per changelog version", () => {
    const entries = parseChangelogTsx(SYNTH);
    const xml = buildAtomFeed(entries, "https://example.com");
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<title>VulnRap Changelog</title>");
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://example.com/changelog/feed.xml"/>',
    );
    expect(xml).toContain(
      '<link rel="alternate" type="text/html" href="https://example.com/changelog"/>',
    );
    // Two synth entries → two <entry> blocks.
    const entryCount = xml.match(/<entry>/g)?.length ?? 0;
    expect(entryCount).toBe(2);
    expect(xml).toContain("v9.9.9 — Synth");
    expect(xml).toContain("https://example.com/changelog#v9.9.9");
    expect(xml).toContain("<published>2026-05-03T00:00:00.000Z</published>");
    expect(xml).toContain("<updated>2026-05-03T00:00:00.000Z</updated>");
    // Item text should be escaped and present inside the html-typed content.
    // Inside CDATA the raw '"' is preserved (no entity escape needed).
    expect(xml).toContain('item one with ] bracket inside');
    expect(xml).toContain('item two with "escaped quotes"');
    expect(xml).toContain("<![CDATA[");
    expect(xml).toContain("]]>");
    expect(xml.endsWith("</feed>")).toBe(true);
  });

  it("produces a feed against the real changelog with an entry per version", () => {
    const entries = loadChangelogEntries();
    const xml = buildAtomFeed(entries, "https://vulnrap.com");
    const entryCount = xml.match(/<entry>/g)?.length ?? 0;
    expect(entryCount).toBe(entries.length);
    // Top-level <updated> should match the newest entry's date.
    expect(xml).toContain(`<updated>${new Date(`${entries[0].date}T00:00:00Z`).toISOString()}</updated>`);
  });
});
