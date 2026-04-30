import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_PUBLIC_URL,
  buildPublicUrl,
  buildPublicUrlForRequest,
  type PublicUrlRequest,
} from "./public-url";

function fakeRequest(opts: {
  protocol?: string;
  host?: string | undefined;
}): PublicUrlRequest {
  return {
    protocol: opts.protocol ?? "https",
    get(name: "host") {
      if (name === "host") return opts.host;
      return undefined;
    },
  };
}

describe("buildPublicUrl", () => {
  let originalPublicUrl: string | undefined;

  beforeEach(() => {
    originalPublicUrl = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;
  });

  describe("PUBLIC_URL set", () => {
    it("uses PUBLIC_URL as the base", () => {
      process.env.PUBLIC_URL = "https://prod.example.com";
      expect(buildPublicUrl()).toBe("https://prod.example.com");
    });

    it("strips a single trailing slash from PUBLIC_URL", () => {
      process.env.PUBLIC_URL = "https://prod.example.com/";
      expect(buildPublicUrl()).toBe("https://prod.example.com");
    });

    it("strips multiple trailing slashes from PUBLIC_URL", () => {
      process.env.PUBLIC_URL = "https://prod.example.com///";
      expect(buildPublicUrl()).toBe("https://prod.example.com");
    });

    it("ignores whitespace-only PUBLIC_URL values", () => {
      process.env.PUBLIC_URL = "   ";
      const req = fakeRequest({ protocol: "http", host: "self.example" });
      // Falls through to req origin because the env value is effectively empty.
      expect(buildPublicUrl({ req })).toBe("http://self.example");
    });

    it("prefers PUBLIC_URL over a request-derived origin", () => {
      process.env.PUBLIC_URL = "https://canonical.example.com";
      const req = fakeRequest({ protocol: "http", host: "request.example" });
      expect(buildPublicUrl({ req })).toBe("https://canonical.example.com");
    });

    it("appends a path with a leading slash", () => {
      process.env.PUBLIC_URL = "https://prod.example.com/";
      expect(buildPublicUrl({ path: "/verify/42" })).toBe(
        "https://prod.example.com/verify/42",
      );
    });

    it("normalizes a path missing its leading slash", () => {
      process.env.PUBLIC_URL = "https://prod.example.com";
      expect(buildPublicUrl({ path: "docs/runbook.md" })).toBe(
        "https://prod.example.com/docs/runbook.md",
      );
    });
  });

  describe("PUBLIC_URL unset, with req", () => {
    it("derives the base from the request origin", () => {
      const req = fakeRequest({ protocol: "http", host: "self.example:8080" });
      expect(buildPublicUrl({ req })).toBe("http://self.example:8080");
    });

    it("appends paths to the request-derived origin", () => {
      const req = fakeRequest({ protocol: "https", host: "self.example" });
      expect(
        buildPublicUrl({
          req,
          path: "/changelog#verification-sources",
        }),
      ).toBe("https://self.example/changelog#verification-sources");
    });

    it("falls back to the canonical default when req has no host", () => {
      const req = fakeRequest({ protocol: "http", host: undefined });
      expect(buildPublicUrl({ req })).toBe(DEFAULT_PUBLIC_URL);
    });
  });

  describe("PUBLIC_URL unset, no req", () => {
    it("returns the canonical default", () => {
      expect(buildPublicUrl()).toBe(DEFAULT_PUBLIC_URL);
      expect(DEFAULT_PUBLIC_URL).toBe("https://vulnrap.com");
    });

    it("appends a path to the canonical default", () => {
      expect(buildPublicUrl({ path: "/feedback-analytics" })).toBe(
        "https://vulnrap.com/feedback-analytics",
      );
    });

    it("treats a null req as no req (no crash)", () => {
      expect(buildPublicUrl({ req: null })).toBe(DEFAULT_PUBLIC_URL);
    });
  });

  describe("override option", () => {
    it("uses the override and ignores PUBLIC_URL and req", () => {
      process.env.PUBLIC_URL = "https://env.example.com";
      const req = fakeRequest({ protocol: "http", host: "request.example" });
      expect(
        buildPublicUrl({
          override: "https://override.example.com/",
          req,
        }),
      ).toBe("https://override.example.com");
    });

    it("ignores empty / whitespace overrides and falls through", () => {
      process.env.PUBLIC_URL = "https://env.example.com";
      expect(buildPublicUrl({ override: "" })).toBe("https://env.example.com");
      expect(buildPublicUrl({ override: "   " })).toBe(
        "https://env.example.com",
      );
    });

    it("ignores a null override", () => {
      process.env.PUBLIC_URL = "https://env.example.com";
      expect(buildPublicUrl({ override: null })).toBe(
        "https://env.example.com",
      );
    });
  });

  describe("buildPublicUrlForRequest", () => {
    it("matches buildPublicUrl({ req, path })", () => {
      const req = fakeRequest({ protocol: "https", host: "self.example" });
      expect(buildPublicUrlForRequest(req, "/verify/9")).toBe(
        "https://self.example/verify/9",
      );
    });

    it("handles a missing request gracefully", () => {
      expect(buildPublicUrlForRequest(undefined)).toBe(DEFAULT_PUBLIC_URL);
      expect(buildPublicUrlForRequest(null, "/x")).toBe(
        "https://vulnrap.com/x",
      );
    });
  });
});
