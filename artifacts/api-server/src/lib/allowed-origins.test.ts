import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCorsOriginCallback,
  parseAllowedOrigins,
  validateAllowedOriginsEnv,
  type AllowedOriginsEnvLogger,
  type AllowedOriginsEnvValidationResult,
} from "./allowed-origins";

type LogFn = (obj: object, msg: string) => void;

function recordingLogger() {
  const warn = vi.fn<LogFn>();
  const error = vi.fn<LogFn>();
  const logger: AllowedOriginsEnvLogger = { warn, error };
  return Object.assign(logger, { warn, error });
}

describe("parseAllowedOrigins", () => {
  it("returns an empty list when the value is undefined", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it("returns an empty list when the value is whitespace-only", () => {
    expect(parseAllowedOrigins("   ")).toEqual([]);
  });

  it("trims surrounding whitespace and normalises trailing slashes", () => {
    expect(
      parseAllowedOrigins(" https://a.example.com , https://b.example.com/ "),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("drops malformed entries instead of throwing", () => {
    expect(
      parseAllowedOrigins("https://ok.example.com,not-a-url,ftp://x.example"),
    ).toEqual(["https://ok.example.com"]);
  });
});

describe("validateAllowedOriginsEnv", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = original;
  });

  describe("ALLOWED_ORIGINS unset", () => {
    it("returns kind 'unset' and warns about open CORS mode", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({ logger });
      expect(result).toEqual({ kind: "unset" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      const [obj, msg] = logger.warn.mock.calls[0]!;
      expect(obj).toMatchObject({ fallback: "allow-all-cross-origin" });
      expect(msg).toContain("ALLOWED_ORIGINS is not set");
      expect(msg).toContain("every cross-origin request");
    });

    it("treats whitespace-only ALLOWED_ORIGINS as unset", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "   " },
      });
      expect(result).toEqual({ kind: "unset" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("does not throw when no logger is supplied", () => {
      expect(() => validateAllowedOriginsEnv()).not.toThrow();
      expect(validateAllowedOriginsEnv()).toEqual({ kind: "unset" });
    });
  });

  describe("ALLOWED_ORIGINS valid", () => {
    it("returns kind 'valid' and emits no log lines for a single https origin", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "https://app.example.com" },
      });
      expect(result).toEqual({
        kind: "valid",
        origins: ["https://app.example.com"],
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("accepts multiple comma-separated origins and trims each entry", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: {
          ALLOWED_ORIGINS:
            " https://a.example.com , http://localhost:3000 ,https://b.example.com ",
        },
      });
      expect(result).toEqual({
        kind: "valid",
        origins: [
          "https://a.example.com",
          "http://localhost:3000",
          "https://b.example.com",
        ],
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("normalises a trailing slash so it matches a browser-sent Origin", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "https://app.example.com/" },
      });
      expect(result).toEqual({
        kind: "valid",
        origins: ["https://app.example.com"],
      });
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("ALLOWED_ORIGINS malformed", () => {
    it("rejects an entry missing a scheme entirely", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "app.example.com" },
      });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.origins).toEqual([]);
        expect(result.invalidEntries).toEqual([
          {
            value: "app.example.com",
            reason: "must start with http:// or https://",
          },
        ]);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("rejects a non-http(s) protocol such as ftp://", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "ftp://files.example.com" },
      });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.origins).toEqual([]);
        expect(result.invalidEntries[0]?.value).toBe(
          "ftp://files.example.com",
        );
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("rejects a scheme typo missing the // separator (https:example.com)", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "https:example.com" },
      });
      expect(result.kind).toBe("invalid");
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("rejects an entry that includes a path component", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "https://app.example.com/dashboard" },
      });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.origins).toEqual([]);
        expect(result.invalidEntries[0]?.reason).toContain("origin");
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("rejects an empty entry produced by a stray comma", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: { ALLOWED_ORIGINS: "https://a.example.com,,https://b.example.com" },
      });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.origins).toEqual([
          "https://a.example.com",
          "https://b.example.com",
        ]);
        expect(result.invalidEntries).toEqual([
          { value: "", reason: "empty entry" },
        ]);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("keeps valid entries in the returned origins list and reports each malformed entry", () => {
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({
        logger,
        env: {
          ALLOWED_ORIGINS:
            "https://ok.example.com,not-a-url,ftp://x.example,https://also-ok.example.com",
        },
      });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.origins).toEqual([
          "https://ok.example.com",
          "https://also-ok.example.com",
        ]);
        expect(result.invalidEntries.map((e) => e.value)).toEqual([
          "not-a-url",
          "ftp://x.example",
        ]);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [obj] = logger.error.mock.calls[0]!;
      expect(obj).toMatchObject({
        validOrigins: [
          "https://ok.example.com",
          "https://also-ok.example.com",
        ],
      });
    });
  });

  describe("buildCorsOriginCallback", () => {
    function decide(
      validation: AllowedOriginsEnvValidationResult,
      origin: string | undefined,
    ): { err: Error | null; allow: boolean | undefined } {
      const cb = buildCorsOriginCallback(validation);
      let captured: { err: Error | null; allow: boolean | undefined } = {
        err: null,
        allow: undefined,
      };
      cb(origin, (err, allow) => {
        captured = { err, allow };
      });
      return captured;
    }

    it("always allows requests without an Origin header (same-origin / curl)", () => {
      // No Origin header is sent for same-origin / non-browser callers, so
      // it must be allowed under every validation result — including the
      // malformed-only case below — otherwise we would lock out the SPA
      // talking to its own backend.
      for (const v of [
        { kind: "unset" } as const,
        { kind: "valid", origins: ["https://app.example.com"] } as const,
        {
          kind: "invalid",
          origins: [],
          invalidEntries: [{ value: "bad", reason: "bad" }],
        } as const,
      ]) {
        expect(decide(v, undefined)).toEqual({ err: null, allow: true });
      }
    });

    it("allows every cross-origin request when ALLOWED_ORIGINS is unset", () => {
      const v: AllowedOriginsEnvValidationResult = { kind: "unset" };
      expect(decide(v, "https://anything.example")).toEqual({
        err: null,
        allow: true,
      });
      expect(decide(v, "http://random.local:9999")).toEqual({
        err: null,
        allow: true,
      });
    });

    it("only allows listed origins when ALLOWED_ORIGINS is valid", () => {
      const v: AllowedOriginsEnvValidationResult = {
        kind: "valid",
        origins: ["https://app.example.com", "http://localhost:3000"],
      };
      expect(decide(v, "https://app.example.com")).toEqual({
        err: null,
        allow: true,
      });
      expect(decide(v, "http://localhost:3000")).toEqual({
        err: null,
        allow: true,
      });
      expect(decide(v, "https://evil.example")).toEqual({
        err: null,
        allow: false,
      });
    });

    it("only allows the surviving valid entries when some entries are malformed", () => {
      const v: AllowedOriginsEnvValidationResult = {
        kind: "invalid",
        origins: ["https://ok.example.com"],
        invalidEntries: [
          { value: "ftp://x.example", reason: "must start with http(s)" },
        ],
      };
      expect(decide(v, "https://ok.example.com")).toEqual({
        err: null,
        allow: true,
      });
      expect(decide(v, "ftp://x.example")).toEqual({
        err: null,
        allow: false,
      });
      expect(decide(v, "https://evil.example")).toEqual({
        err: null,
        allow: false,
      });
    });

    it("denies every cross-origin request when every entry is malformed (no silent allow-all)", () => {
      // Regression guard: a typo that leaves the allow-list empty must
      // NOT collapse back into the unset/allow-all branch. Otherwise a
      // single bad copy-paste would expose the API to every origin.
      const v: AllowedOriginsEnvValidationResult = {
        kind: "invalid",
        origins: [],
        invalidEntries: [
          { value: "app.example.com", reason: "missing scheme" },
        ],
      };
      expect(decide(v, "https://app.example.com")).toEqual({
        err: null,
        allow: false,
      });
      expect(decide(v, "https://anything.example")).toEqual({
        err: null,
        allow: false,
      });
      // Same-origin / non-browser callers (no Origin header) still pass.
      expect(decide(v, undefined)).toEqual({ err: null, allow: true });
    });
  });

  describe("env override", () => {
    it("falls back to process.env when no env is provided", () => {
      process.env.ALLOWED_ORIGINS = "https://from-process-env.example.com";
      const logger = recordingLogger();
      const result = validateAllowedOriginsEnv({ logger });
      expect(result).toEqual({
        kind: "valid",
        origins: ["https://from-process-env.example.com"],
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
