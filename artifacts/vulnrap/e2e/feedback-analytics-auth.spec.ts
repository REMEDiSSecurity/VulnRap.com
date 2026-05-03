import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Route } from "@playwright/test";

// Task #216 — UI smoke test for the Task #117 reviewer-token indicator
// (badge + red rejection banner) on /feedback-analytics.
//
// The indicator's state derives entirely from
// `GET /api/feedback/calibration/auth-status`, which the api-server computes
// from `process.env.CALIBRATION_TOKEN` (server side) and the request's
// `X-Calibration-Token` header (client side). Two production-relevant
// postures need real coverage:
//
//   1. "Open mode" — the api-server has no CALIBRATION_TOKEN set, so the
//      gate is a no-op and mutations are open to any caller. The badge must
//      read "Reviewer token: not required" and no banner must render.
//
//   2. "Missing token" — the api-server has CALIBRATION_TOKEN set, but the
//      UI build was produced WITHOUT VITE_CALIBRATION_TOKEN, so the page's
//      probe arrives with no header. The badge must read "Reviewer token:
//      missing" and the red "Calibration mutations will be rejected" banner
//      must render.
//
// Both postures are exercised against REAL api-server processes:
//   - The default playwright-managed api-server (which has CALIBRATION_TOKEN
//     baked in via playwright.config.ts) handles the "missing" scenario; the
//     spec uses page.route() to strip the X-Calibration-Token header from the
//     auth-status request so the running server sees a tokenless probe.
//   - A second api-server side-car is spawned in beforeAll on a free port
//     WITHOUT CALIBRATION_TOKEN; the spec uses page.route() to forward the
//     auth-status request to that side-car for the "open" scenario.
//
// The Vitest sibling at src/pages/feedback-analytics-auth.test.tsx covers
// the same three states (open / missing / configured) at fast unit speed
// against a mocked fetch. This Playwright spec verifies that the same
// branches light up against the real production bundle, the real preview
// proxy, and a real Express api-server process — closing the gap that a
// pure component test cannot reach (build-time env wiring, preview proxy
// behaviour, real header propagation).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const API_SERVER_DIST = path.resolve(
  REPO_ROOT,
  "artifacts/api-server/dist/index.mjs",
);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Failed to allocate free port"));
      }
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/healthz`);
      if (res.ok) return;
      lastErr = new Error(`healthz returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `side-car api-server at ${baseUrl} did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}

let openSidecar: ChildProcessWithoutNullStreams | null = null;
let openSidecarPort = 0;
let openSidecarBase = "";

const DEFAULT_API_PORT = Number(process.env.E2E_API_PORT || 8080);
const DEFAULT_API_BASE =
  process.env.E2E_API_BASE || `http://127.0.0.1:${DEFAULT_API_PORT}`;

test.describe("Feedback Analytics — reviewer-token indicator (Task #117)", () => {
  test.beforeAll(async () => {
    openSidecarPort = await getFreePort();
    openSidecarBase = `http://127.0.0.1:${openSidecarPort}`;

    // Spawn a second instance of the bundled production api-server with
    // CALIBRATION_TOKEN intentionally cleared so its auth-status route
    // returns serverRequiresToken=false. We deliberately use the same
    // dist/index.mjs that the playwright webServer block above runs so
    // both processes execute identical code — the only delta is env.
    openSidecar = spawn("node", ["--enable-source-maps", API_SERVER_DIST], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(openSidecarPort),
        // Force open mode regardless of how the parent shell is configured.
        CALIBRATION_TOKEN: "",
        // Match the playwright-managed api-server's runtime env so any
        // NODE_ENV-gated startup paths behave identically.
        NODE_ENV: "production",
        // Avoid clashing with the default api-server's drift scheduler /
        // notification side effects in the side-car.
        AVRI_DRIFT_WEBHOOK_URL: "",
      },
      stdio: "pipe",
    });

    // Surface side-car crashes loudly so a regression isn't silently
    // misdiagnosed as a flaky page.route() forward.
    openSidecar.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (/error|fatal|throw/i.test(text)) {
        console.error(`[open-mode side-car stderr] ${text}`);
      }
    });
    openSidecar.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        console.error(
          `[open-mode side-car] exited unexpectedly code=${code} signal=${signal}`,
        );
      }
    });

    await waitForHealth(openSidecarBase, 60_000);

    // Sanity-check: the side-car really is in open mode. If a stray
    // CALIBRATION_TOKEN leaked into the spawned env this assertion would
    // fail loudly here, before any UI test runs against a misconfigured
    // server.
    const probe = await fetch(
      `${openSidecarBase}/api/feedback/calibration/auth-status`,
    );
    expect(probe.ok, `side-car auth-status probe failed: ${probe.status}`).toBe(
      true,
    );
    const body = (await probe.json()) as {
      serverRequiresToken: boolean;
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    };
    expect(body).toEqual({
      serverRequiresToken: false,
      tokenPresented: false,
      tokenValid: false,
      mutationsAllowed: true,
    });
  });

  test.afterAll(async () => {
    if (openSidecar && openSidecar.exitCode === null) {
      const proc = openSidecar;
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        // Hard-kill if the side-car ignores SIGTERM so the worker can exit.
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 5_000);
      });
    }
    openSidecar = null;
  });

  // Helper: forward an intercepted auth-status request to a real api-server
  // using Node's built-in fetch from the spec process. We bypass
  // route.fetch() here because it inherits the page's APIRequestContext —
  // including playwright.config.ts's `extraHTTPHeaders["X-Calibration-Token"]`
  // — which silently re-adds the very header we're trying to strip and
  // turns a "missing" probe into a "configured" one. Node fetch carries no
  // such defaults, so the forwarded request is exactly the headers we
  // pass and nothing else.
  async function forwardAuthStatus(
    route: Route,
    upstream: string,
  ): Promise<void> {
    // Build a header set that drops every credential the test environment
    // might inject (the X-Calibration-Token from playwright config, plus a
    // Bearer fallback). What's left is everything the page would send if
    // VITE_CALIBRATION_TOKEN had been unset at build time.
    const headers = { ...route.request().headers() };
    delete headers["x-calibration-token"];
    delete headers["authorization"];
    // Drop hop-by-hop / browser-only headers so a vanilla Node fetch
    // doesn't reject them (e.g. :authority pseudo-headers from HTTP/2).
    delete headers["host"];
    delete headers[":method"];
    delete headers[":path"];
    delete headers[":scheme"];
    delete headers[":authority"];
    const upstreamRes = await fetch(upstream, {
      method: route.request().method(),
      headers: headers as Record<string, string>,
    });
    const body = await upstreamRes.text();
    const respHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      // Drop hop-by-hop response headers Playwright will reject when
      // fulfilling the intercepted request.
      const lower = k.toLowerCase();
      if (lower === "content-length" || lower === "transfer-encoding") return;
      respHeaders[k] = v;
    });
    await route.fulfill({
      status: upstreamRes.status,
      headers: respHeaders,
      body,
    });
  }

  test('badge reads "Reviewer token: not required" against an api-server with no CALIBRATION_TOKEN', async ({
    page,
  }) => {
    // Forward only the auth-status probe to the open-mode side-car; every
    // other /api/* request continues to hit the default api-server (with
    // its seed data, calibration report, feedback rows, etc.) so the page
    // still reaches its CalibrationSection render path.
    await page.route("**/api/feedback/calibration/auth-status", (route) =>
      forwardAuthStatus(
        route,
        `${openSidecarBase}/api/feedback/calibration/auth-status`,
      ),
    );

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    // The badge text is the cross-component contract — exercising it via
    // visible text rather than an internal data-testid keeps the spec
    // honest about what a reviewer actually sees on the page.
    await expect(page.getByText("Reviewer token: not required")).toBeVisible({
      timeout: 15_000,
    });

    // The red rejection banner must NOT appear in open mode. Asserting
    // count==0 (instead of just "not visible") catches a regression where
    // CalibrationAuthBanner forgets the early-return for the "open" case.
    await expect(
      page.getByText("Calibration mutations will be rejected"),
    ).toHaveCount(0);
  });

  test("red banner appears when api-server has CALIBRATION_TOKEN but the UI build lacks VITE_CALIBRATION_TOKEN", async ({
    page,
  }) => {
    // Route the auth-status probe through the DEFAULT (playwright-managed)
    // api-server, which has CALIBRATION_TOKEN set, but strip the
    // X-Calibration-Token header from the request first. This is the
    // production-faithful simulation of a UI bundle produced without
    // VITE_CALIBRATION_TOKEN: the bundled customFetch wouldn't attach
    // the header, and playwright.config.ts's extraHTTPHeaders (which the
    // runtime build can't influence) is the only reason the browser would
    // otherwise send one. The forward helper drops it for us.
    await page.route("**/api/feedback/calibration/auth-status", (route) =>
      forwardAuthStatus(
        route,
        `${DEFAULT_API_BASE}/api/feedback/calibration/auth-status`,
      ),
    );

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    await expect(page.getByText("Reviewer token: missing")).toBeVisible({
      timeout: 15_000,
    });

    // The red banner is the operator-facing escalation — its headline plus
    // the VITE_CALIBRATION_TOKEN guidance copy must both be visible so a
    // future copy edit doesn't silently break the banner's diagnostic value.
    await expect(
      page.getByText("Calibration mutations will be rejected"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/VITE_CALIBRATION_TOKEN was unset at build time/),
    ).toBeVisible();
  });
});
