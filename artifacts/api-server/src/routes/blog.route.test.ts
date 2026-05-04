// Task #712 — Blog Atom feed tests.
//
// Boots an isolated express app with the blog router mounted at root and
// exercises GET /blog/feed.xml end-to-end. Uses node:http directly to
// match the pattern used by other route tests in this folder.
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import blogRouter, { buildBlogAtomFeed } from "./blog";
import type { AddressInfo } from "node:net";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.PUBLIC_URL = "https://vulnrap.com";
  const app: Express = express();
  app.use(blogRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function fetchText(path: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.text();
  const headers: http.IncomingHttpHeaders = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body };
}

describe("GET /blog/feed.xml", () => {
  it("serves an Atom feed with the expected content-type and root element", async () => {
    const res = await fetchText("/blog/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/atom\+xml/);
    expect(res.headers["cache-control"]).toContain("max-age=3600");
    expect(res.body).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
    expect(res.body).toContain('xmlns="http://www.w3.org/2005/Atom"');
    expect(res.body).toContain("<title>VulnRap Blog</title>");
  });

  it("includes one <entry> per curated blog post with required fields", async () => {
    const res = await fetchText("/blog/feed.xml");
    const entryCount = (res.body.match(/<entry>/g) || []).length;
    expect(entryCount).toBeGreaterThanOrEqual(10);
    expect((res.body.match(/<id>/g) || []).length).toBe(entryCount + 1);
    expect((res.body.match(/<updated>/g) || []).length).toBe(entryCount + 1);
    expect((res.body.match(/<summary>/g) || []).length).toBe(entryCount);
  });

  it("links each entry to /blog#<id> on the public site", async () => {
    const res = await fetchText("/blog/feed.xml");
    expect(res.body).toMatch(
      /href="https:\/\/vulnrap\.com\/blog#update13-mcp-launch"/,
    );
    expect(res.body).toMatch(/href="https:\/\/vulnrap\.com\/blog#first-post"/);
  });

  it("escapes XML-special characters in titles and summaries", () => {
    const xml = buildBlogAtomFeed(null, [
      {
        id: "test",
        title: "Title with <script> & \"quotes\" 'apostrophes'",
        date: "2026-04-01",
        summary: "Summary with <tags> & ampersands",
      },
    ]);
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&apos;");
    expect(xml).not.toMatch(/<script>alert/);
  });

  it("orders entries newest first by date", async () => {
    const res = await fetchText("/blog/feed.xml");
    const updatedMatches = [
      ...res.body.matchAll(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/g),
    ].map((m) => m[1]);
    expect(updatedMatches.length).toBeGreaterThan(0);
    const sorted = [...updatedMatches].sort(
      (a, b) => Date.parse(b) - Date.parse(a),
    );
    expect(updatedMatches).toEqual(sorted);
  });
});

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseFeed(xml: string) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (_name: string, jpath: string) => jpath === "feed.entry",
  });
  return parser.parse(xml);
}

describe("Atom 1.0 spec conformance", () => {
  let feed: Record<string, any>;

  beforeAll(async () => {
    const res = await fetchText("/blog/feed.xml");
    feed = parseFeed(res.body).feed;
  });

  it("has all required feed-level elements (RFC 4287 §4.1.1)", () => {
    expect(feed.title).toBeDefined();
    expect(feed.id).toBeDefined();
    expect(feed.updated).toBeDefined();
    expect(feed.author).toBeDefined();
    expect(feed.author.name).toBeDefined();
  });

  it("has a self link and an alternate link on the feed", () => {
    const links: Array<Record<string, string>> = Array.isArray(feed.link)
      ? feed.link
      : [feed.link];
    const self = links.find((l) => l["@_rel"] === "self");
    const alt = links.find((l) => l["@_rel"] === "alternate");
    expect(self).toBeDefined();
    expect(self!["@_type"]).toBe("application/atom+xml");
    expect(self!["@_href"]).toMatch(/^https?:\/\//);
    expect(alt).toBeDefined();
    expect(alt!["@_type"]).toBe("text/html");
    expect(alt!["@_href"]).toMatch(/^https?:\/\//);
  });

  it("has all required entry-level elements (RFC 4287 §4.1.2)", () => {
    const entries: Array<Record<string, any>> = feed.entry;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.title).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.updated).toBeDefined();
      expect(entry.author).toBeDefined();
      expect(entry.author.name).toBeDefined();
      const link = Array.isArray(entry.link) ? entry.link[0] : entry.link;
      expect(link).toBeDefined();
      expect(link["@_rel"]).toBe("alternate");
      expect(link["@_href"]).toMatch(/^https?:\/\//);
    }
  });

  it("every <id> is unique across the entire feed", () => {
    const ids: string[] = [
      feed.id,
      ...feed.entry.map((e: Record<string, any>) => e.id),
    ];
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("feed-level <updated> is a valid RFC-3339 timestamp", () => {
    expect(String(feed.updated)).toMatch(RFC3339);
  });

  it("every entry <updated> is a valid RFC-3339 timestamp", () => {
    for (const entry of feed.entry) {
      expect(String(entry.updated)).toMatch(RFC3339);
    }
  });

  it("every entry <published> (if present) is a valid RFC-3339 timestamp", () => {
    for (const entry of feed.entry) {
      if (entry.published !== undefined) {
        expect(String(entry.published)).toMatch(RFC3339);
      }
    }
  });

  it("entry ids use tag: URI scheme (RFC 4151)", () => {
    for (const entry of feed.entry) {
      expect(String(entry.id)).toMatch(/^tag:[^,]+,\d{4}-\d{2}-\d{2}:/);
    }
  });
});
