// Task #724 — OpenTelemetry tracing init.
//
// This module is imported FIRST from index.ts (before any other application
// imports) so the auto-instrumentations can patch http / express / pg before
// they are required by downstream modules.
//
// The tracing SDK only starts when OTEL_EXPORTER_OTLP_ENDPOINT is set, so
// unconfigured environments pay zero startup or runtime cost.
import { logger } from "./logger";

let started = false;

export async function initTracing(): Promise<void> {
  if (started) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || endpoint.trim() === "") {
    return;
  }

  try {
    const [
      { NodeSDK },
      { OTLPTraceExporter },
      { getNodeAutoInstrumentations },
      { resourceFromAttributes },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/auto-instrumentations-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

    const serviceName = process.env.OTEL_SERVICE_NAME || "api-server";
    const serviceVersion = process.env.npm_package_version || "0.0.0";

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs is extremely chatty; disable to keep traces useful.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdk.start();
    started = true;
    // Publish the trace-id reader on globalThis so the logger mixin can
    // pick it up without statically importing this module. See logger.ts
    // for why we go through globalThis instead of a normal import.
    (
      globalThis as unknown as { __vulnrapTraceIdProvider?: () => string | undefined }
    ).__vulnrapTraceIdProvider = getCurrentTraceId;
    logger.info({ endpoint, serviceName }, "OpenTelemetry tracing started");

    process.once("SIGTERM", () => {
      sdk
        .shutdown()
        .catch((err: unknown) => logger.warn({ err }, "OTel shutdown error"));
    });
  } catch (err) {
    logger.warn({ err }, "OpenTelemetry init failed; continuing without tracing");
  }
}

interface MinimalSpanContext {
  traceId?: string;
}
interface MinimalSpan {
  spanContext(): MinimalSpanContext;
}
interface MinimalOtel {
  trace: { getActiveSpan(): MinimalSpan | undefined };
}

export function getCurrentTraceId(): string | undefined {
  if (!started) return undefined;
  try {
    // Lazy require so we don't pull @opentelemetry/api types globally —
    // the SDK already loaded the runtime module by the time this runs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otel = require("@opentelemetry/api") as MinimalOtel;
    const span = otel.trace.getActiveSpan();
    const ctx = span?.spanContext();
    if (ctx?.traceId && ctx.traceId !== "00000000000000000000000000000000") {
      return ctx.traceId;
    }
  } catch {
    // ignore
  }
  return undefined;
}
