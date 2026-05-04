// Task #712 — Blog RSS (Atom) feed.
//
// Companion to the changelog feed. Loads the curated blog post metadata
// from `data/blog-posts.json` once at module import time and serves it as
// an Atom 1.0 feed at `GET /blog/feed.xml`.
//
// Mounted at the application root (not under `/api`) because feed readers
// and the auto-discovery <link> in blog.tsx point at `/blog/feed.xml`
// directly, matching the path convention the task spec calls out.
import { Router, type IRouter, type Request } from "express";
import { buildPublicUrl } from "../lib/public-url";
import { loadBlogPostsMeta, type BlogPostMeta } from "../lib/blog-posts";

const BLOG_POSTS = loadBlogPostsMeta();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toIsoDate(date: string): string {
  // Treat bare YYYY-MM-DD as midnight UTC so feed readers get a stable
  // RFC-3339 timestamp regardless of the host timezone.
  const parsed = new Date(date.length === 10 ? `${date}T00:00:00Z` : date);
  return parsed.toISOString();
}

export function buildBlogAtomFeed(
  req: Request | null,
  posts: BlogPostMeta[] = BLOG_POSTS,
): string {
  const baseUrl = buildPublicUrl({ req: req ?? undefined });
  const feedUrl = buildPublicUrl({
    req: req ?? undefined,
    path: "/blog/feed.xml",
  });
  const blogUrl = buildPublicUrl({ req: req ?? undefined, path: "/blog" });

  // Sort newest first, mirroring the on-page order.
  const sorted = [...posts].sort(
    (a, b) => Date.parse(b.date) - Date.parse(a.date),
  );
  const updated =
    sorted.length > 0 ? toIsoDate(sorted[0].date) : new Date().toISOString();

  const entries = sorted
    .map((post) => {
      const postUrl = `${blogUrl}/${post.id}`;
      const isoDate = toIsoDate(post.date);
      // Tag URI per RFC 4151 — stable, opaque, does not require the URL
      // to resolve. Uses the host of the configured public URL.
      const host = (() => {
        try {
          return new URL(baseUrl).host;
        } catch {
          return "vulnrap.com";
        }
      })();
      const tagId = `tag:${host},${post.date.slice(0, 10)}:/blog/${post.id}`;
      return `  <entry>
    <title>${escapeXml(post.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(postUrl)}"/>
    <id>${escapeXml(tagId)}</id>
    <updated>${isoDate}</updated>
    <published>${isoDate}</published>
    <author><name>REMEDiS Security</name></author>
    <summary>${escapeXml(post.summary)}</summary>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>VulnRap Blog</title>
  <subtitle>Updates, technical deep-dives, and the occasional rant about vulnerability report quality.</subtitle>
  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>
  <link rel="alternate" type="text/html" href="${escapeXml(blogUrl)}"/>
  <id>${escapeXml(blogUrl)}</id>
  <updated>${updated}</updated>
  <author><name>REMEDiS Security</name></author>
${entries}
</feed>
`;
}

const router: IRouter = Router();

router.get("/blog/feed.xml", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.type("application/atom+xml; charset=utf-8").send(buildBlogAtomFeed(req));
});

export default router;
