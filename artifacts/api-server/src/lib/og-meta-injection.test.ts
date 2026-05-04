import { describe, it, expect } from "vitest";
import {
  extractReportIdFromPath,
  injectOgMeta,
  type OgMeta,
} from "./og-meta-injection";

describe("extractReportIdFromPath", () => {
  it("extracts a numeric id from /results/:id", () => {
    expect(extractReportIdFromPath("/results/42")).toBe(42);
  });

  it("handles trailing slash", () => {
    expect(extractReportIdFromPath("/results/42/")).toBe(42);
  });

  it("returns null for non-results paths", () => {
    expect(extractReportIdFromPath("/")).toBeNull();
    expect(extractReportIdFromPath("/about")).toBeNull();
    expect(extractReportIdFromPath("/results")).toBeNull();
  });

  it("returns null for non-numeric ids", () => {
    expect(extractReportIdFromPath("/results/abc")).toBeNull();
  });

  it("returns null for zero or negative ids", () => {
    expect(extractReportIdFromPath("/results/0")).toBeNull();
    expect(extractReportIdFromPath("/results/-1")).toBeNull();
  });

  it("returns null for nested paths beyond the id", () => {
    expect(extractReportIdFromPath("/results/42/edit")).toBeNull();
  });
});

describe("injectOgMeta", () => {
  const sampleHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://vulnrap.com/" />
    <meta property="og:title" content="VulnRap — VirusTotal for Bug Reports" />
    <meta property="og:description" content="Validate vulnerability reports instantly." />
    <meta property="og:image" content="https://vulnrap.com/opengraph.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="VulnRap — VirusTotal for Bug Reports" />
    <meta name="twitter:description" content="Validate vulnerability reports instantly." />
    <meta name="twitter:image" content="https://vulnrap.com/opengraph.jpg" />
  </head>
  <body><div id="root"></div></body>
</html>`;

  const meta: OgMeta = {
    ogImage: "https://vulnrap.com/api/og/result/42.png",
    ogImageWidth: "1200",
    ogImageHeight: "630",
    ogImageType: "image/png",
    ogTitle: "VulnRap Report VR-42 — Slop Score: 62/100 (Likely Slop)",
    ogDescription:
      "Vulnerability report scored 62/100 (Likely Slop). Validate claims, detect AI slop, catch duplicates. Free and anonymous.",
    ogUrl: "https://vulnrap.com/results/42",
    twitterImage: "https://vulnrap.com/api/og/result/42.png",
    twitterCard: "summary_large_image",
  };

  it("replaces og:image with the dynamic card URL", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain(
      'property="og:image" content="https://vulnrap.com/api/og/result/42.png"',
    );
    expect(result).not.toContain("opengraph.jpg");
  });

  it("replaces og:image:type from image/jpeg to image/png", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain(
      'property="og:image:type" content="image/png"',
    );
    expect(result).not.toContain("image/jpeg");
  });

  it("replaces og:title with the report-specific title", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain(
      'property="og:title" content="VulnRap Report VR-42',
    );
  });

  it("replaces og:url with the report-specific URL", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain(
      'property="og:url" content="https://vulnrap.com/results/42"',
    );
  });

  it("replaces twitter:image with the dynamic card URL", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain(
      'name="twitter:image" content="https://vulnrap.com/api/og/result/42.png"',
    );
  });

  it("replaces twitter:title with the report-specific title", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain(
      'name="twitter:title" content="VulnRap Report VR-42',
    );
  });

  it("replaces twitter:description with the report-specific description", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain("scored 62/100");
  });

  it("uses absolute URLs — every og:image and twitter:image starts with https://", () => {
    const result = injectOgMeta(sampleHtml, meta);
    const ogImageMatch = result.match(
      /property="og:image"\s+content="([^"]*)"/,
    );
    const twitterImageMatch = result.match(
      /name="twitter:image"\s+content="([^"]*)"/,
    );
    expect(ogImageMatch?.[1]).toMatch(/^https?:\/\//);
    expect(twitterImageMatch?.[1]).toMatch(/^https?:\/\//);
  });

  it("escapes HTML-special characters in meta values", () => {
    const xssMeta: OgMeta = {
      ...meta,
      ogTitle: 'Report with "quotes" & <tags>',
      ogDescription: 'Description with "quotes" & <tags>',
    };
    const result = injectOgMeta(sampleHtml, xssMeta);
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;");
    expect(result).toContain("&lt;tags&gt;");
    expect(result).not.toContain('<tags>');
  });

  it("preserves the rest of the HTML unchanged", () => {
    const result = injectOgMeta(sampleHtml, meta);
    expect(result).toContain('<div id="root"></div>');
    expect(result).toContain('property="og:type" content="website"');
  });
});
