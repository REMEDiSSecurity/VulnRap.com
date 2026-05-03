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
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import router from "./routes";
import metricsRouter from "./routes/metrics";
import blogRouter from "./routes/blog";
import sitemapRouter from "./routes/sitemap";
import changelogFeedRouter from "./routes/changelog-feed";
import { logger } from "./lib/logger";
import { buildPublicUrl, validatePublicUrlEnv } from "./lib/public-url";
import { requestIdMiddleware } from "./middlewares/request-id";
import { httpMetricsMiddleware } from "./middlewares/http-metrics";

// Task #462 — Resolve __dirname from import.meta.url so this file works under
// any pure-ESM loader (no esbuild banner) as well as the bundled output. The
// esbuild banner in build.mjs sets globalThis.__dirname for dist/index.mjs;
// this local const shadows it harmlessly because in the bundle,
// fileURLToPath(import.meta.url) resolves to the same dist/ path the banner
// injects, so the candidate paths below still resolve identically.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

validatePublicUrlEnv({ logger });

const app: Express = express();

// Replit's deploy infrastructure terminates TLS and forwards via a single proxy hop,
// so trust the first X-Forwarded-* header. Required for express-rate-limit to read
// the real client IP and for any downstream code that uses req.ip / req.protocol.
app.set("trust proxy", 1);

app.use(compression());

const defaultHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
});

const swaggerHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
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
          url: req.url?.split("?")[0],
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

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
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

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
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

if (swaggerDocument) {
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerDocument, {
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: "VulnRap API Documentation",
    }),
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
  app.use((_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
