# Observability — Metrics, Tracing, Request IDs

The api-server emits Prometheus-formatted metrics, OpenTelemetry-compatible
traces, and per-request correlation IDs out of the box. Everything is
opt-in for sensitive bits (tracing / scrape-token) and defaults to "useful
locally, safe in production."

## Quick reference: env vars

| Variable                       | Default        | Effect                                              |
| ------------------------------ | -------------- | --------------------------------------------------- |
| `METRICS_ENABLED`              | `true`         | Set `false` to make `GET /api/metrics` 404.         |
| `METRICS_TOKEN`                | _(unset)_      | When set, scrape requests need `Authorization: Bearer <token>`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | _(unset)_      | When set, OpenTelemetry SDK starts and exports OTLP/HTTP traces. |
| `OTEL_SERVICE_NAME`            | `api-server`   | Service name attached to spans.                     |
| `LOG_LEVEL`                    | `info`         | Pino log level.                                     |

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the OpenTelemetry SDK is never
loaded, so unconfigured environments pay zero startup or runtime cost.

## `/api/metrics` — Prometheus scrape

```sh
curl -s http://localhost:8080/api/metrics | head
```

The endpoint exposes:

| Metric                                          | Type      | Notes                                                  |
| ----------------------------------------------- | --------- | ------------------------------------------------------ |
| `vulnrap_http_request_duration_seconds`         | histogram | labels: `method`, `route`, `status_code`               |
| `vulnrap_http_requests_total`                   | counter   | labels: `method`, `route`, `status_code`               |
| `vulnrap_http_requests_in_flight`               | gauge     | labels: `method`                                       |
| `vulnrap_report_submitted_total`                | counter   | label: `outcome`                                       |
| `vulnrap_report_redacted_total`                 | counter   |                                                        |
| `vulnrap_similarity_match_total`                | counter   |                                                        |
| `vulnrap_external_api_call_total`               | counter   | labels: `provider` (`github`/`openai`/`nvd`), `outcome`|
| `vulnrap_external_api_call_duration_seconds`    | histogram | labels: `provider`, `outcome`                          |
| `vulnrap_pg_pool_total` / `_idle` / `_waiting`  | gauges    | sampled every 5 s                                      |
| `vulnrap_process_*`, `vulnrap_nodejs_*`         | various   | default Node.js / GC / event-loop metrics              |

Routes are reported as the matched template (e.g. `/api/reports/:id`) so
label cardinality stays bounded; unmatched URLs roll up to `unmatched`.

The endpoint never includes per-report PII — only counters / durations.

### Scrape config

```yaml
scrape_configs:
  - job_name: vulnrap-api
    metrics_path: /api/metrics
    static_configs:
      - targets: ['api.example.com']
    # Only when METRICS_TOKEN is set:
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
```

## OpenTelemetry tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces` to
enable tracing. The SDK auto-instruments `http`, `express`, and `pg`, so
incoming requests, downstream HTTP calls, and SQL queries appear as spans
without any code changes.

Each request's trace id is also injected into Pino log lines as
`trace_id`, so a Grafana / Loki query for a trace id pulls every log line
the request emitted.

## Request IDs

Every inbound request is assigned an id (ULID) — or honours an inbound
`X-Request-Id` header when one is provided. The id is:

* echoed back in the `X-Request-Id` response header,
* attached to every Pino log line for that request as `req.id`,
* propagated to outbound calls to GitHub, NVD, and OpenAI as
  `X-Request-Id`,
* surfaced to the SPA as `error.requestId` (and rendered as
  "Reference ID: …" in the error-boundary fallback) so support tickets
  can quote a single, stable identifier.

### Worked example

A user reports "the analyse button just exploded with reference ID
`01HXYZA7G3F2WC9N…`". To pull the corresponding line:

```sh
# Pino is line-delimited JSON to stdout — pipe to jq.
journalctl -u vulnrap-api -o cat | jq -c 'select(.req.id == "01HXYZA7G3F2WC9N...")'
```

If tracing is enabled, that log line also carries a `trace_id` you can
paste into the Grafana / Tempo / Jaeger trace explorer to see the full
span tree (HTTP → Express → pg → outbound GitHub / OpenAI).

## Sensitive headers

Pino redacts the following before serialising:

* `req.headers.authorization`
* `req.headers.cookie`
* `req.headers['x-calibration-token']`
* `req.headers['x-api-key']`
* `res.headers['set-cookie']`

A unit test (`logger.test.ts`) asserts that submitting a `cookie` header
never produces it verbatim in the serialised log output.

## Grafana dashboard

A starter dashboard (a single row of HTTP latency / RPS / error rate, plus
external-API call rate and pg pool depth) is shipped at
[`grafana-dashboard.json`](./observability/grafana-dashboard.json).

Import: Grafana → Dashboards → New → Import → upload JSON → pick your
Prometheus datasource.
