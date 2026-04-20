#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "dist/public");

const ROUTES = [
  "/",
  "/blog",
  "/changelog",
  "/developers",
  "/use-cases",
  "/security",
  "/privacy",
  "/terms",
];

const NAV_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

function waitForServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(async (res, rej) => {
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url, { method: "GET" });
        if (r.ok) return res();
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    rej(new Error(`Server at ${url} did not become ready in ${timeoutMs}ms`));
  });
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[prerender] starting vite preview on ${baseUrl}`);
  const preview = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port) } }
  );
  preview.stdout.on("data", d => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on("data", d => process.stderr.write(`[preview] ${d}`));

  let cleanup = async () => {
    if (!preview.killed) {
      preview.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 200));
      if (!preview.killed) preview.kill("SIGKILL");
    }
  };
  process.on("exit", () => { cleanup(); });
  process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

  try {
    await waitForServer(baseUrl);
    console.log(`[prerender] preview ready, launching chromium`);

    const browser = await chromium.launch();
    const context = await browser.newContext({
      userAgent: "VulnRapPrerender/1.0 (+https://vulnrap.com)",
    });

    // Block external API calls so prerender doesn't hit the network or hang.
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(baseUrl)) return route.continue();
      // Allow data: and inline; block everything else (fonts, analytics, api)
      if (url.startsWith("data:")) return route.continue();
      return route.abort();
    });

    const page = await context.newPage();
    const results = [];

    for (const route of ROUTES) {
      const url = `${baseUrl}${route}`;
      try {
        console.log(`[prerender] ${route}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        // Wait for React to mount and for any lazy chunks to load
        await page.waitForFunction(
          () => {
            const root = document.getElementById("root");
            return !!root && root.childElementCount > 0;
          },
          { timeout: NAV_TIMEOUT_MS }
        ).catch(() => { /* fall through and snapshot whatever we have */ });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(SETTLE_MS);

        const html = await page.content();
        const outPath = route === "/"
          ? resolve(OUT_DIR, "index.html")
          : resolve(OUT_DIR, route.replace(/^\//, ""), "index.html");
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, html, "utf8");
        results.push({ route, ok: true, bytes: html.length, outPath });
      } catch (err) {
        results.push({ route, ok: false, error: String(err?.message || err) });
      }
    }

    await browser.close();

    const ok = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    console.log(`\n[prerender] ${ok.length}/${ROUTES.length} routes prerendered`);
    for (const r of ok) console.log(`  ✓ ${r.route.padEnd(20)} ${(r.bytes / 1024).toFixed(1)} KB → ${r.outPath.replace(ROOT + "/", "")}`);
    for (const r of failed) console.log(`  ✗ ${r.route.padEnd(20)} ${r.error}`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main().catch(err => {
  // Soft-fail: prerender is a SEO enhancement, not required for the app to work.
  // If chromium can't launch in the deploy environment, the build still ships
  // the regular SPA shell which works fine for browsers but is empty for bots.
  console.warn("[prerender] failed (non-fatal — SPA still shipped):", err?.message || err);
  process.exit(0);
});
