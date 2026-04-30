import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_PUBLIC_URL,
  buildPublicUrl,
  buildPublicUrlForRequest,
  validatePublicUrlEnv,
  type PublicUrlEnvLogger,
  type PublicUrlRequest,
} from "./public-url";

type LogFn = (obj: object, msg: string) => void;

function recordingLogger() {
  const warn = vi.fn<LogFn>();
  const error = vi.fn<LogFn>();
  const logger: PublicUrlEnvLogger = { warn, error };
  return Object.assign(logger, { warn, error });
}

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

describe("validatePublicUrlEnv", () => {
  let originalPublicUrl: string | undefined;

  beforeEach(() => {
    originalPublicUrl = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;
  });

  describe("PUBLIC_URL unset", () => {
    it("returns kind 'unset' and warns about request-origin fallback", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({ logger });
      expect(result).toEqual({ kind: "unset" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      const [obj, msg] = logger.warn.mock.calls[0]!;
      expect(obj).toMatchObject({ fallback: "request-origin-or-default" });
      expect(msg).toContain("PUBLIC_URL is not set");
      expect(msg).toContain("fall back");
    });

    it("treats whitespace-only PUBLIC_URL as unset", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "   " },
      });
      expect(result).toEqual({ kind: "unset" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("does not throw when no logger is supplied", () => {
      expect(() => validatePublicUrlEnv()).not.toThrow();
      expect(validatePublicUrlEnv()).toEqual({ kind: "unset" });
    });
  });

  describe("PUBLIC_URL valid", () => {
    it("returns kind 'valid' and emits no log lines for an https URL", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "https://prod.example.com" },
      });
      expect(result).toEqual({
        kind: "valid",
        url: "https://prod.example.com",
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("accepts an http:// URL", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "http://self-hosted.local:8080" },
      });
      expect(result).toEqual({
        kind: "valid",
        url: "http://self-hosted.local:8080",
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("trims surrounding whitespace before validating", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "  https://prod.example.com  " },
      });
      expect(result).toEqual({
        kind: "valid",
        url: "https://prod.example.com",
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("PUBLIC_URL malformed", () => {
    it("returns kind 'malformed' and logs an error for a value that passes the scheme prefix but fails URL.parse", () => {
      // The string starts with `https://` so the prefix guard passes, but
      // `new URL("https://[bad")` throws because of the unmatched bracket
      // in the host. This exercises the URL.parse failure branch
      // specifically (separate from the scheme-prefix branch).
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "https://[bad" },
      });
      expect(result.kind).toBe("malformed");
      if (result.kind === "malformed") {
        expect(result.value).toBe("https://[bad");
        expect(result.reason.length).toBeGreaterThan(0);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      const [obj, msg] = logger.error.mock.calls[0]!;
      expect(obj).toMatchObject({ publicUrl: "https://[bad" });
      expect(msg).toContain("PUBLIC_URL");
      expect(msg).toContain("parseable");
    });

    it("rejects a non-http(s) protocol such as ftp://", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "ftp://files.example.com" },
      });
      expect(result.kind).toBe("malformed");
      if (result.kind === "malformed") {
        expect(result.value).toBe("ftp://files.example.com");
        expect(result.reason.length).toBeGreaterThan(0);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      const [, msg] = logger.error.mock.calls[0]!;
      expect(msg).toContain("http://");
      expect(msg).toContain("https://");
    });

    it("rejects a value that is missing a scheme entirely", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "prod.example.com/foo" },
      });
      expect(result.kind).toBe("malformed");
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("rejects a scheme typo missing the // separator (https:example.com)", () => {
      // Without a strict prefix check, `new URL("https:example.com")` would
      // happily parse and `.protocol` would be `"https:"`, so the value
      // would be treated as valid even though it would yield broken
      // canonical links when concatenated as a base URL.
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "https:example.com" },
      });
      expect(result.kind).toBe("malformed");
      if (result.kind === "malformed") {
        expect(result.value).toBe("https:example.com");
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      const [, msg] = logger.error.mock.calls[0]!;
      expect(msg).toContain("http://");
      expect(msg).toContain("https://");
    });

    it("rejects an http: scheme typo missing the // separator (http:foo)", () => {
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({
        logger,
        env: { PUBLIC_URL: "http:foo" },
      });
      expect(result.kind).toBe("malformed");
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("env override", () => {
    it("falls back to process.env when no env is provided", () => {
      process.env.PUBLIC_URL = "https://from-process-env.example.com";
      const logger = recordingLogger();
      const result = validatePublicUrlEnv({ logger });
      expect(result).toEqual({
        kind: "valid",
        url: "https://from-process-env.example.com",
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
