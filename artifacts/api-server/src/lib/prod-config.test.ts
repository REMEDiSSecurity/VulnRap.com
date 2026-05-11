import { describe, it, expect, vi } from "vitest";
import { validateProductionConfig } from "./prod-config";

type LogFn = (obj: object, msg: string) => void;
function recordingLogger() {
  const warn = vi.fn<LogFn>();
  const error = vi.fn<LogFn>();
  return { warn, error };
}

const FULL_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PUBLIC_URL: "https://vulnrap.com",
  ALLOWED_ORIGINS: "https://vulnrap.com",
  CALIBRATION_TOKEN: "cal-token",
  VISITOR_HMAC_KEY: "visitor-key",
  METRICS_TOKEN: "metrics-token",
};

describe("validateProductionConfig", () => {
  it("returns the per-validator results in dev without throwing on missing values", () => {
    const logger = recordingLogger();
    const result = validateProductionConfig({
      env: { NODE_ENV: "development" },
      logger,
    });
    expect(result.publicUrl.kind).toBe("unset");
    expect(result.allowedOrigins.kind).toBe("unset");
    // Two warnings from the per-validator helpers; no thrown error.
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not throw in production when every required value is present", () => {
    const logger = recordingLogger();
    expect(() =>
      validateProductionConfig({ env: { ...FULL_PROD_ENV }, logger }),
    ).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("throws in production when PUBLIC_URL is missing", () => {
    const env = { ...FULL_PROD_ENV };
    delete env.PUBLIC_URL;
    expect(() => validateProductionConfig({ env })).toThrow(/PUBLIC_URL/);
  });

  it("throws in production when ALLOWED_ORIGINS is missing", () => {
    const env = { ...FULL_PROD_ENV };
    delete env.ALLOWED_ORIGINS;
    expect(() => validateProductionConfig({ env })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("throws in production when ALLOWED_ORIGINS is set but every entry is malformed", () => {
    const env = { ...FULL_PROD_ENV, ALLOWED_ORIGINS: "not-a-url,also-bad" };
    expect(() => validateProductionConfig({ env })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("throws in production when CALIBRATION_TOKEN is missing", () => {
    const env = { ...FULL_PROD_ENV };
    delete env.CALIBRATION_TOKEN;
    expect(() => validateProductionConfig({ env })).toThrow(
      /CALIBRATION_TOKEN/,
    );
  });

  it("throws in production when METRICS_TOKEN is missing", () => {
    const env = { ...FULL_PROD_ENV };
    delete env.METRICS_TOKEN;
    expect(() => validateProductionConfig({ env })).toThrow(/METRICS_TOKEN/);
  });

  it("throws in production when VISITOR_HMAC_KEY is missing", () => {
    const env = { ...FULL_PROD_ENV };
    delete env.VISITOR_HMAC_KEY;
    expect(() => validateProductionConfig({ env })).toThrow(/VISITOR_HMAC_KEY/);
  });

  it("treats whitespace-only secrets as missing", () => {
    const env = { ...FULL_PROD_ENV, CALIBRATION_TOKEN: "   " };
    expect(() => validateProductionConfig({ env })).toThrow(
      /CALIBRATION_TOKEN/,
    );
  });

  it("collects every problem into a single error message", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    let caught: Error | null = null;
    try {
      validateProductionConfig({ env });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = caught!.message;
    expect(msg).toContain("PUBLIC_URL");
    expect(msg).toContain("ALLOWED_ORIGINS");
    expect(msg).toContain("CALIBRATION_TOKEN");
    expect(msg).toContain("VISITOR_HMAC_KEY");
    expect(msg).toContain("METRICS_TOKEN");
  });
});
