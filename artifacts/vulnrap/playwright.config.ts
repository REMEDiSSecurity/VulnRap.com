import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root is two levels up from artifacts/vulnrap/. The api-server resolves
// archetype-history.json relative to process.cwd(); when pnpm --filter
// launches it from the api-server package directory the relative default
// "artifacts/api-server/data/archetype-history.json" lands inside a stray
// nested artifacts/api-server/ subdir. Pinning to an absolute path keeps
// the file in the canonical workspace data dir regardless of cwd.
const REPO_ROOT = path.resolve(__dirname, "../..");
const ARCHETYPE_HISTORY_PATH = path.join(
  REPO_ROOT,
  "artifacts/api-server/data/archetype-history.json",
);

const VULNRAP_PORT = Number(process.env.E2E_VULNRAP_PORT || process.env.PORT || 20749);
const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${VULNRAP_PORT}`;
// Task #152 — `/feedback/calibration/handwavy-phrases` GET is gated by
// `requireCalibrationAuthStrict` (Task #163) which ALWAYS requires a token,
// even in dev. Without it the panel renders "No phrases configured." and
// every spec that drives the panel UI fails. We default a known token here
// so the Playwright-managed webservers (and the per-test API contexts) all
// agree on the same value; CI can override via E2E_CALIBRATION_TOKEN.
const CALIBRATION_TOKEN = process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Send the calibration token on every browser request so the strict GET
    // for the hand-wavy phrase panel succeeds even though the page bundle
    // itself doesn't carry VITE_CALIBRATION_TOKEN at runtime.
    extraHTTPHeaders: {
      "X-Calibration-Token": CALIBRATION_TOKEN,
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
            process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
            undefined,
        },
      },
    },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : [
        {
          command:
            "pnpm --filter @workspace/api-server run dev",
          url: `http://127.0.0.1:${API_PORT}/api/healthz`,
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            VULNRAP_USE_NEW_COMPOSITE: "true",
            PORT: String(API_PORT),
            // Required for the hand-wavy phrase panel's GET (strict auth).
            CALIBRATION_TOKEN,
            // Pin the archetype-history file to its canonical workspace
            // path so a non-root webserver cwd doesn't create a stray
            // nested artifacts/api-server/ directory.
            ARCHETYPE_HISTORY_PATH,
          },
        },
        {
          command: "pnpm --filter @workspace/vulnrap run dev",
          url: BASE_URL,
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PORT: String(VULNRAP_PORT),
            BASE_PATH: "/",
            // Bake the same token into the Vite bundle so the page's own
            // calls (POST/PATCH/DELETE) carry it automatically too.
            VITE_CALIBRATION_TOKEN: CALIBRATION_TOKEN,
          },
        },
      ],
});
