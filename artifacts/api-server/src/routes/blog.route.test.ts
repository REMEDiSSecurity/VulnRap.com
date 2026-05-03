// Task #712 — Blog Atom feed tests.
//
// Boots an isolated express app with the blog router mounted at root and
// exercises GET /blog/feed.xml end-to-end. Uses node:http directly to
// match the pattern used by other route tests in this folder.
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
