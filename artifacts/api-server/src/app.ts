import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import fs from "fs";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
    },
  },
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/docs")) {
    return swaggerHelmet(req, res, next);
  }
  return defaultHelmet(req, res, next);
});

app.use(
  pinoHttp({
    logger,
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

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : [];

app.use(cors({
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
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use("/api/reports", submitLimiter);

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
  logger.warn("Could not load OpenAPI spec for Swagger UI from any candidate path");
}

if (swaggerDocument) {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "VulnRap API Documentation",
  }));
}

const SECURITY_TXT = `Contact: mailto:remedisllc@gmail.com
Expires: 2027-12-31T23:59:00.000Z
Preferred-Languages: en
Canonical: https://vulnrap.com/.well-known/security.txt
Policy: https://vulnrap.com/privacy
`;

app.get("/.well-known/security.txt", (_req, res) => {
  res.type("text/plain").send(SECURITY_TXT);
});

app.get("/security.txt", (_req, res) => {
  res.type("text/plain").send(SECURITY_TXT);
});

app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const frontendDir = path.resolve(__dirname, "..", "..", "vulnrap", "dist", "public");
  app.use(express.static(frontendDir, { maxAge: "1d" }));
  app.use((_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
