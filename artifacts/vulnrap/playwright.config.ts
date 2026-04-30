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

// Task #324 — When E2E_DEV_SERVERS=1, point the Playwright webServer
// blocks at the dev-mode commands (`vite` + the api-server's `dev`
// script) instead of the bundled production builds. This makes
// iterative debugging of new specs much faster: edits to api-server
// source rebuild via the artifact's own dev script, and edits to
// vulnrap source hot-reload through the Vite dev server. The
// release-gate still runs against the production builds (default,
// matches what `scripts/vulnrap-e2e-check.sh` invokes), so any
// dev-only convenience cannot mask a release-blocking regression.
//
// The dev-mode swap only works because the artifact-level path
// collision was fixed: previously the api-server claimed both `/api`
// and `/`, so the workspace router stole `/` from vulnrap and the
// browser never reached the Vite dev server. See
// artifacts/api-server/.replit-artifact/artifact.toml.
const USE_DEV_SERVERS = process.env.E2E_DEV_SERVERS === "1";

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
    : USE_DEV_SERVERS
      ? [
          {
            // Task #324 — Dev-mode api-server. The api-server's `dev`
            // script does its own esbuild-then-start (see
            // artifacts/api-server/package.json), so we don't need the
            // build-if-stale wrapper here; rerunning Playwright will
            // rebuild fresh dist/ output for whatever sources changed.
            // NODE_ENV is left at "development" so dev-only branches
            // (e.g. handwavy panel default token, verbose logging) are
            // exercised — this is the whole point of the dev-mode
            // harness, since the production-build webserver below
            // hardcodes NODE_ENV=production.
            command: "pnpm --filter @workspace/api-server run dev",
            url: `http://127.0.0.1:${API_PORT}/api/healthz`,
            reuseExistingServer: true,
            timeout: 240_000,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              VULNRAP_USE_NEW_COMPOSITE: "true",
              PORT: String(API_PORT),
              NODE_ENV: "development",
              CALIBRATION_TOKEN,
              ARCHETYPE_HISTORY_PATH,
              HANDWAVY_ALLOW_TEST_BACKDATE: "1",
            },
          },
          {
            // Task #324 — Dev-mode vulnrap via the Vite dev server. Vite
            // proxies /api -> DEV_API_PROXY_TARGET (default
            // http://localhost:8080; see server.proxy in vite.config.ts),
            // so the api-server above is reachable through the same
            // baseURL the browser hits. We pass DEV_API_PROXY_TARGET
            // explicitly so a caller-supplied E2E_API_PORT actually
            // reaches the dev proxy — without this, overriding the api
            // port in dev mode would silently still proxy to :8080.
            // There is no build step: edits to vulnrap source HMR-
            // reload, which is the whole convenience this dev-mode
            // harness exists to unlock.
            command: "pnpm --filter @workspace/vulnrap run dev",
            url: BASE_URL,
            reuseExistingServer: true,
            timeout: 120_000,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PORT: String(VULNRAP_PORT),
              BASE_PATH: "/",
              NODE_ENV: "development",
              VITE_CALIBRATION_TOKEN: CALIBRATION_TOKEN,
              DEV_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
            },
          },
        ]
      : [
        {
          // Run the bundled production api-server (dist/index.mjs via `start`),
          // not `dev`. The `build-if-stale.mjs` helper rebuilds only when
          // dist/index.mjs is missing or older than the watched sources, so
          // back-to-back release-gate runs don't pay the full esbuild cost.
          // Set E2E_SKIP_PROD_BUILD=1 to trust the existing dist (CI builds
          // in a separate stage); set E2E_FORCE_PROD_BUILD=1 to always
          // rebuild. The full build still mirrors what ships in the
          // [services.production] block of artifacts/api-server/.replit-artifact/artifact.toml.
          command:
            "node ../../scripts/build-if-stale.mjs api-server && pnpm --filter @workspace/api-server run start",
          url: `http://127.0.0.1:${API_PORT}/api/healthz`,
          reuseExistingServer: true,
          timeout: 240_000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            VULNRAP_USE_NEW_COMPOSITE: "true",
            PORT: String(API_PORT),
            // Match the runtime env the deployed api-server runs under (see
            // [services.production.run.env] in
            // artifacts/api-server/.replit-artifact/artifact.toml) so any
            // NODE_ENV-gated behaviour is exercised by the smoke test.
            NODE_ENV: "production",
            // Required for the hand-wavy phrase panel's GET (strict auth).
            CALIBRATION_TOKEN,
            // Pin the archetype-history file to its canonical workspace
            // path so a non-root webserver cwd doesn't create a stray
            // nested artifacts/api-server/ directory.
            ARCHETYPE_HISTORY_PATH,
            // Task #223 — opt the api-server into honoring a caller-
            // supplied `addedAt` on POST /handwavy-phrases. The undo
            // urgent-state spec uses this to seed a phrase whose
            // 5-minute undo window is ~25s from elapsing, so the
            // `text-red-400` / `animate-pulse` / `data-undo-urgent="true"`
            // branch can be exercised without 4m 30s of real wall-clock
            // wait. Production leaves this unset, so the field is silently
            // dropped and the audit timestamp comes from `new Date()`.
            HANDWAVY_ALLOW_TEST_BACKDATE: "1",
          },
        },
        {
          // Build the production vite bundle and serve it via `vite preview`,
          // not `vite` (dev). The preview server proxies /api to the bundled
          // api-server above (see preview.proxy in vite.config.ts), so a
          // base-path or bundle regression will surface here. The
          // `build-if-stale.mjs` helper skips the vite build when
          // dist/public/index.html is newer than every watched source — see
          // the api-server webServer block above for the env knobs
          // (E2E_SKIP_PROD_BUILD, E2E_FORCE_PROD_BUILD).
          command:
            "node ../../scripts/build-if-stale.mjs vulnrap && pnpm --filter @workspace/vulnrap run serve",
          url: BASE_URL,
          reuseExistingServer: true,
          timeout: 240_000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PORT: String(VULNRAP_PORT),
            BASE_PATH: "/",
            NODE_ENV: "production",
            PREVIEW_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
            // Bake the same token into the Vite bundle so the page's own
            // calls (POST/PATCH/DELETE) carry it automatically too.
            VITE_CALIBRATION_TOKEN: CALIBRATION_TOKEN,
          },
        },
      ],
});
