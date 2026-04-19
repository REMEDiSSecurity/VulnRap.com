import { defineConfig, devices } from "@playwright/test";

const VULNRAP_PORT = Number(process.env.E2E_VULNRAP_PORT || process.env.PORT || 20749);
const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${VULNRAP_PORT}`;

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
          },
        },
      ],
});
