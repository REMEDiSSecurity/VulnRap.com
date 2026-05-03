import pino from "pino";

// Task #724 — Centralised pino logger.
//
// Enrichments:
//   - base fields: name (artifact), version (from package.json env), env
//   - mixin: live trace_id from the active OTel span when tracing is on
//   - redact list covers every header that can carry a credential or session
//     state so they never reach a log file even if a downstream serializer
//     forgets to strip them.
//
// NOTE: the trace-id mixin avoids a static import of `./instrumentation`
// (which transitively pulls @opentelemetry/api types into every file that
// imports the logger and has been observed to cascade into unrelated TS
// inference regressions). We resolve the helper via globalThis at call
// time, which is set by `instrumentation.ts` once tracing has actually
// started.
const isProduction = process.env.NODE_ENV === "production";
const version = process.env.npm_package_version || "0.0.0";

interface TraceIdProvider {
  (): string | undefined;
}

function readTraceId(): string | undefined {
  const provider = (
    globalThis as unknown as { __vulnrapTraceIdProvider?: TraceIdProvider }
  ).__vulnrapTraceIdProvider;
  if (typeof provider !== "function") return undefined;
  try {
    return provider();
  } catch {
    return undefined;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    name: "api-server",
    version,
    env: process.env.NODE_ENV ?? "development",
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-calibration-token']",
      "req.headers['x-api-key']",
      "res.headers['set-cookie']",
      "headers.authorization",
      "headers.cookie",
      "headers['x-calibration-token']",
    ],
    censor: "[REDACTED]",
  },
  mixin() {
    const traceId = readTraceId();
    return traceId ? { trace_id: traceId } : {};
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
