import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(helmet());

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

const replitDomains = process.env.REPLIT_DOMAINS
  ? process.env.REPLIT_DOMAINS.split(",").map(d => `https://${d.trim()}`)
  : [];

const replitDevDomain = process.env.REPLIT_DEV_DOMAIN
  ? [`https://${process.env.REPLIT_DEV_DOMAIN}`]
  : [];

const allOrigins = [...allowedOrigins, ...replitDomains, ...replitDevDomain];

app.use(cors({
  origin: allOrigins.length > 0
    ? (origin, callback) => {
        if (!origin || allOrigins.some(o => origin.startsWith(o))) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      }
    : true,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use("/api/reports", limiter);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

export default app;
