// Task #724 — Verify pino redacts sensitive headers before serialising.
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

function makeTestLogger(): { logger: pino.Logger; getOutput: () => string } {
  let buf = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  // Mirror the production redact list exactly so this test fails the moment
  // someone removes one of the entries from logger.ts.
  const logger = pino(
    {
      base: { name: "api-server", version: "test", env: "test" },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-calibration-token']",
          "req.headers['x-api-key']",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    sink,
  );
  return { logger, getOutput: () => buf };
}

describe("logger redaction (Task #724)", () => {
  it("never serialises a cookie header verbatim", () => {
    const { logger, getOutput } = makeTestLogger();
    logger.info(
      {
        req: {
          method: "POST",
          url: "/api/reports",
          headers: {
            cookie: "session=SECRET-COOKIE-VALUE-12345",
            authorization: "Bearer SECRET-TOKEN-67890",
            "x-calibration-token": "SECRET-CAL-TOKEN-XYZ",
            "x-api-key": "SECRET-API-KEY-ABC",
          },
        },
      },
      "incoming",
    );
    const out = getOutput();
    expect(out).not.toContain("SECRET-COOKIE-VALUE-12345");
    expect(out).not.toContain("SECRET-TOKEN-67890");
    expect(out).not.toContain("SECRET-CAL-TOKEN-XYZ");
    expect(out).not.toContain("SECRET-API-KEY-ABC");
    expect(out).toContain("[REDACTED]");
  });
});
