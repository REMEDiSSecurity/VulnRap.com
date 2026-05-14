import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import pinoHttp from "pino-http";

/**
 * Redact secret-bearing path segments before they hit pino's request
 * serializer. Several routes embed unguessable tokens directly in the
 * URL path (Slack hosted-relay notify/disconnect/tenant, report
 * delete-token confirmations, etc.) — those tokens are credential-
 * equivalent and must never appear in server logs, even though the
 * client deliberately puts them in the URL for ergonomics.
 *
 * Logged shape becomes `/api/slack/notify/[REDACTED]` regardless of
 * the secret's length or character set.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /^(\/api\/slack\/(?:notify|disconnect|tenant))\/[^/]+/,
  /^(\/api\/reports\/delete)\/[^/]+/,
];
function redactSensitivePathTokens(
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  for (const re of SENSITIVE_PATH_PATTERNS) {
    const m = url.match(re);
    if (m) return `${m[1]}/[REDACTED]${url.slice(m[0].length)}`;
  }
  return url;
}
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import router from "./routes";
import metricsRouter from "./routes/metrics";
import blogRouter from "./routes/blog";
import sitemapRouter from "./routes/sitemap";
import changelogFeedRouter from "./routes/changelog-feed";
import incidentsFeedRouter from "./routes/incidents-feed";
import { logger } from "./lib/logger";
import { buildPublicUrl } from "./lib/public-url";
import { createSpaFallback } from "./lib/spa-fallback";
import { buildCorsOriginCallback } from "./lib/allowed-origins";
import { validateProductionConfig } from "./lib/prod-config";
import { requestIdMiddleware } from "./middlewares/request-id";
import { httpMetricsMiddleware } from "./middlewares/http-metrics";

// Task #462 — Resolve __dirname from import.meta.url so this file works under
// any pure-ESM loader (no esbuild banner) as well as the bundled output. The
// esbuild banner in build.mjs sets globalThis.__dirname for dist/index.mjs;
// this local const shadows it harmlessly because in the bundle,
// fileURLToPath(import.meta.url) resolves to the same dist/ path the banner
// injects, so the candidate paths below still resolve identically.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Task #1310 — Fail-closed startup validation. In production this throws
// when ALLOWED_ORIGINS / PUBLIC_URL / CALIBRATION_TOKEN /
// VISITOR_HMAC_KEY / METRICS_TOKEN are missing or malformed, so a
// misconfigured deploy refuses to boot instead of accepting traffic
// with permissive defaults. In dev / test it just logs the same
// warnings/errors as before and returns the structured validation
// results.
const { allowedOrigins: allowedOriginsValidation } = validateProductionConfig({
  logger,
});

const IS_PRODUCTION =
  (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";

const app: Express = express();

// Replit's deploy infrastructure terminates TLS and forwards via a single proxy hop,
// so trust the first X-Forwarded-* header. Required for express-rate-limit to read
// the real client IP and for any downstream code that uses req.ip / req.protocol.
app.set("trust proxy", 1);

app.use(compression());

// Task #1310 — Tighten the production CSP:
//   - script-src drops 'unsafe-inline' (the FOUC bootstrap was moved to
//     /bootstrap-theme.js in artifacts/vulnrap/public/; main.tsx is a
//     module script served from the hashed assets/ directory). The one
//     remaining inline <script> is the SEO JSON-LD block in
//     artifacts/vulnrap/index.html — per CSP spec, even
//     application/ld+json blocks are subject to script-src, so we pin
//     it via its sha256 hash. If you change the JSON-LD body, recompute
//     the hash with: `openssl dgst -sha256 -binary < block.txt | base64`
//     and replace JSONLD_HASH below.
//   - dev keeps 'unsafe-inline' so Vite's HMR runtime injection and any
//     ad-hoc inline test snippets keep working without ceremony.
// style-src keeps 'unsafe-inline' because results.tsx / whitepaper.tsx
// inject print-only <style> blocks via dangerouslySetInnerHTML; those
// are CSS not JS and can't be exploited the same way.
const JSONLD_HASH = "'sha256-14JJra+0uojRHYxF8D+tkTEPT0+OSHPYHN+lCc3bjEw='";
const defaultHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: IS_PRODUCTION
        ? ["'self'", JSONLD_HASH]
        : ["'self'", "'unsafe-inline'"],
      // Task #1311 — Brand fonts ship from /fonts/ as self-hosted
      // woff2 files (see @font-face block in artifacts/vulnrap/src/
      // index.css), so font-src is locked to 'self'. Do not add
      // fonts.googleapis.com / fonts.gstatic.com back here unless a
      // future change re-introduces a third-party font CDN — and
      // ideally only with SRI on the stylesheet.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
});

const swaggerHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://validator.swagger.io"],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  xFrameOptions: false,
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/docs")) {
    return swaggerHelmet(req, res, next);
  }
  return defaultHelmet(req, res, next);
});

const NOINDEX_HOSTS = new Set([
  "vulnrap.replit.app",
  "www.vulnrap.replit.app",
]);

app.use((req, res, next) => {
  const host = (req.hostname || "").toLowerCase();
  if (NOINDEX_HOSTS.has(host)) {
    res.setHeader(
      "X-Robots-Tag",
      "noindex, nofollow, noarchive, nositelinkssearchbox",
    );
  }
  next();
});

// Task #724 — Resolve / generate request ID before pino-http so every log
// line includes it via genReqId, and echo it as a response header.
app.use(requestIdMiddleware);

app.use(
  pinoHttp({
    logger,
    // Honour the id resolved by requestIdMiddleware (inbound X-Request-Id or
    // freshly-minted ULID). Stringly typed because Express's req.id type is
    // augmented by pino-http itself.
    genReqId: (req) => (req as unknown as { id: string }).id,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: redactSensitivePathTokens(req.url?.split("?")[0]),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Task #724 — Per-request Prometheus metrics (duration / count / in-flight).
app.use(httpMetricsMiddleware);

// Task #766 — Source the CORS allow-list from validateAllowedOriginsEnv so
// malformed entries (missing scheme, stray commas, pasted URLs with paths)
// are logged once at startup and dropped from the allow-list, instead of
// silently never matching any inbound Origin header. The branching is
// delegated to buildCorsOriginCallback so the policy can be unit-tested
// without spinning up Express. Allow-all is gated on `kind === "unset"`
// only — when ALLOWED_ORIGINS IS set but every entry is malformed we
// deny cross-origin requests instead of reverting to open mode.
app.use(
  cors({
    origin: buildCorsOriginCallback(allowedOriginsValidation),
    // PUT is allowed for the calibration-tunable admin endpoints
    // (e.g. /api/test/archetype-history/config) so reviewer-driven config
    // updates also work in cross-origin setups, not only same-origin
    // proxied ones. The custom x-calibration-token header is the gating
    // credential read by requireCalibrationAuth.
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Calibration-Token"],
    maxAge: 86400,
  }),
);

// Task #1310 — Lowered the global per-IP ceiling on /api/reports from
// 5000 to 600 / 15 min. The narrower analysisLimiter (30 / 15 min)
// still gates the expensive POST endpoints; this outer cap is a
// safety net against drive-by enumeration of GET /api/reports/:id and
// burst floods that the inner limiter can't absorb. A single legitimate
// reviewer browsing report history rarely needs more than ~10 reqs/min,
// so 40/min still leaves several multiples of headroom.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use("/api/reports", submitLimiter);

const analysisLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Analysis rate limit exceeded. Please try again later." },
});
app.post("/api/reports/check", analysisLimiter);
app.post("/api/reports/check/dry-run-batch", analysisLimiter);
app.post("/api/reports", analysisLimiter);

// Task #116 — wrong-token attempts on /api/feedback/calibration mutation
// routes are throttled per-IP. The throttle is integrated into
// requireCalibrationAuth (see middlewares/require-calibration-auth.ts) so
// only failed-auth requests touch the limiter; correct-token calls bypass
// it entirely and are never blocked by an exhausted bucket from the same IP.

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

let swaggerDocument: Record<string, unknown> | null = null;
const specCandidates = [
  path.resolve(__dirname, "openapi.yaml"),
  path.resolve(__dirname, "..", "openapi.yaml"),
  path.resolve(__dirname, "..", "..", "..", "lib", "api-spec", "openapi.yaml"),
];
for (const candidate of specCandidates) {
  try {
    if (fs.existsSync(candidate)) {
      swaggerDocument = YAML.load(candidate) as Record<string, unknown>;
      break;
    }
  } catch {
    continue;
  }
}
if (!swaggerDocument) {
  logger.warn(
    "Could not load OpenAPI spec for Swagger UI from any candidate path",
  );
}

// Task #1310 — Gate Swagger UI in production. The interactive docs
// endpoint loads Swagger's bundle which requires 'unsafe-inline' /
// 'unsafe-eval' in script-src (see swaggerHelmet above). In production
// we only mount it when DOCS_TOKEN is set, and the request must carry
// the matching `Authorization: Bearer <token>` header. The static
// openapi.yaml is still served unconditionally so machine clients
// (codegen, Postman) can fetch the spec.
const docsToken = (process.env.DOCS_TOKEN ?? "").trim();
const docsEnabledInProd = !IS_PRODUCTION || docsToken.length > 0;

if (swaggerDocument && docsEnabledInProd) {
  if (IS_PRODUCTION) {
    app.use("/api/docs", (req, res, next) => {
      const auth = req.header("authorization");
      if (auth !== `Bearer ${docsToken}`) {
        res.status(401).type("text/plain").send("Unauthorized");
        return;
      }
      next();
    });
  }
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerDocument, {
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: "VulnRap API Documentation",
    }),
  );
} else if (swaggerDocument && IS_PRODUCTION) {
  logger.info(
    "DOCS_TOKEN is not set; /api/docs is disabled in production. Set DOCS_TOKEN to a long random string to enable Swagger UI.",
  );
}

// Task #517 — Compute the Expires line dynamically so the file never lapses
// per RFC 9116 §2.5.5 (the timestamp MUST be in the future, and values longer
// than a year out are explicitly not recommended). The default rollover
// window is 90 days; deployments can tune it via SECURITY_TXT_EXPIRY_DAYS,
// and any value outside the (0, 365] range is clamped to that range so a
// misconfigured env var can't produce an invalid file.
const SECURITY_TXT_DEFAULT_EXPIRY_DAYS = 90;
const SECURITY_TXT_MAX_EXPIRY_DAYS = 365;

export function resolveSecurityTxtExpiryDays(
  raw: string | undefined = process.env.SECURITY_TXT_EXPIRY_DAYS,
): number {
  if (raw === undefined || raw.trim() === "") {
    return SECURITY_TXT_DEFAULT_EXPIRY_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SECURITY_TXT_DEFAULT_EXPIRY_DAYS;
  }
  if (parsed > SECURITY_TXT_MAX_EXPIRY_DAYS) {
    return SECURITY_TXT_MAX_EXPIRY_DAYS;
  }
  return parsed;
}

export function computeSecurityTxtExpires(now: Date = new Date()): string {
  const days = resolveSecurityTxtExpiryDays();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}

// Build the security.txt body per-request so Canonical / Policy resolve
// through the shared buildPublicUrl helper (PUBLIC_URL → request origin →
// vulnrap.com fallback) instead of being hard-coded.
function buildSecurityTxt(req: Request): string {
  const canonical = buildPublicUrl({ req, path: "/.well-known/security.txt" });
  const policy = buildPublicUrl({ req, path: "/privacy" });
  const expires = computeSecurityTxtExpires();
  return `Contact: mailto:remedisllc@gmail.com
Expires: ${expires}
Preferred-Languages: en
Canonical: ${canonical}
Policy: ${policy}
`;
}

app.get("/.well-known/security.txt", (req, res) => {
  res.type("text/plain").send(buildSecurityTxt(req));
});

app.get("/security.txt", (req, res) => {
  res.type("text/plain").send(buildSecurityTxt(req));
});

// Task #712 — Blog Atom feed at /blog/feed.xml. Mounted at the root
// (not under /api) because feed readers and the auto-discovery <link>
// in blog.tsx point at the unprefixed path.
app.use(blogRouter);

// Task #710 — Mount the dynamic sitemap at the app root so the canonical
// `/sitemap.xml` URL referenced from `robots.txt` resolves directly
// (i.e. not under the `/api` prefix). Mounted *before* the static
// frontend below so the dynamic handler wins over any stale on-disk
// `sitemap.xml` shipped in the SPA's public/ directory.
app.use(sitemapRouter);

// Task #711 — Public Atom feed for the changelog. Mounted at the app root
// (not under /api) so the public URL is /changelog/feed.xml, matching the
// auto-discovery <link rel="alternate"> injected into the changelog page.
app.use(changelogFeedRouter);

// Task #1058 — Public Atom feed for incident postmortems. Mounted at the app
// root so the public URL is /incidents/feed.xml, matching the auto-discovery
// <link rel="alternate"> injected into the incidents page.
app.use(incidentsFeedRouter);

// Task #724 — Mount the Prometheus scrape endpoint under /api so it inherits
// the same helmet / CORS / trust-proxy posture. The handler enforces its own
// METRICS_ENABLED / METRICS_TOKEN gating.
app.use("/api", metricsRouter);

app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const frontendDir = path.resolve(
    __dirname,
    "..",
    "..",
    "vulnrap",
    "dist",
    "public",
  );
  // Task #726 — Long-cache hashed assets and never-cache the SPA shell.
  // Vite emits hashed filenames under /assets/* (see rollup output config),
  // so they're safe to mark `immutable` for a full year. The HTML shell
  // and any non-/assets/ static file (favicons, robots.txt, sitemap.xml,
  // prerender output) must revalidate on every load so a fresh deploy is
  // visible immediately.
  const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
  app.use(
    express.static(frontendDir, {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        const rel = path
          .relative(frontendDir, filePath)
          .split(path.sep)
          .join("/");
        if (rel.startsWith("assets/")) {
          res.setHeader(
            "Cache-Control",
            `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
          );
        } else if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else {
          // Favicons / robots.txt / sitemap.xml / prerender shells — short
          // cache with revalidation so a deploy propagates within minutes
          // instead of waiting for a hard refresh.
          res.setHeader(
            "Cache-Control",
            "public, max-age=300, must-revalidate",
          );
        }
      },
    }),
  );
  app.use(createSpaFallback(frontendDir));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
