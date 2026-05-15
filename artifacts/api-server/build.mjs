import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, copyFile } from "node:fs/promises";
import { build as esbuild, context as esbuildContext } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const watchMode = process.argv.includes("--watch");

function makeRestartPlugin() {
  let child = null;
  let restartTimer = null;

  function killChild() {
    if (!child) return Promise.resolve();
    const c = child;
    child = null;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      c.once("exit", finish);
      try {
        c.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      // Force-kill if the child doesn't exit quickly
      setTimeout(() => {
        if (!done) {
          try {
            c.kill("SIGKILL");
          } catch {}
          finish();
        }
      }, 1500).unref();
    });
  }

  function spawnChild() {
    const entry = path.resolve(artifactDir, "dist/index.mjs");
    child = spawn(process.execPath, ["--enable-source-maps", entry], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("exit", (code, signal) => {
      // Only log unexpected exits; expected restarts null `child` first.
      if (child && code !== 0 && !signal) {
        console.error(`[dev] child process exited with code ${code}`);
      }
    });
  }

  async function restart() {
    await killChild();
    spawnChild();
  }

  process.on("SIGINT", async () => {
    await killChild();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await killChild();
    process.exit(0);
  });

  return {
    name: "dev-restart",
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors && result.errors.length > 0) return;
        // Copy the OpenAPI spec next to the freshly-built dist/index.mjs so
        // app.ts's spec-candidate path resolution succeeds. Doing this here
        // (inside onEnd) avoids the startup-noise warning that fires when the
        // top-level copyOpenApiSpec() runs before the first watch build.
        await copyOpenApiSpec();
        // Debounce in case of rapid successive rebuilds
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          restart().catch((err) => console.error("[dev] restart failed:", err));
        }, 50);
      });
    },
  };
}

async function readBuildInfo() {
  const rootPkgPath = path.resolve(artifactDir, "..", "..", "package.json");
  const specPath = path.resolve(artifactDir, "..", "..", "lib", "api-spec", "openapi.yaml");

  let projectVersion = "0.0.0-dev";
  try {
    const pkg = JSON.parse(await readFile(rootPkgPath, "utf8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      projectVersion = pkg.version;
    }
  } catch {}

  let specVersion = "0.0.0-dev";
  try {
    const yaml = await readFile(specPath, "utf8");
    const m = yaml.match(/^\s*version:\s*([^\s#]+)/m);
    if (m) specVersion = m[1].replace(/^['"]|['"]$/g, "");
  } catch {}

  // Allow CI / release script to pass a precomputed sha; otherwise derive
  // from the working tree. Falls back to "dev" so an installable tarball
  // outside a git checkout still builds.
  let gitSha = process.env.VULNRAP_GIT_SHA ?? "";
  if (!gitSha) {
    try {
      const r = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
        encoding: "utf8",
      });
      if (r.status === 0) gitSha = r.stdout.trim();
    } catch {}
  }
  if (!gitSha) gitSha = "dev";

  const builtAt = process.env.VULNRAP_BUILT_AT ?? new Date().toISOString();
  return { projectVersion, specVersion, gitSha, builtAt };
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  const buildInfo = await readBuildInfo();
  console.log(
    `[build-info] projectVersion=${buildInfo.projectVersion} specVersion=${buildInfo.specVersion} gitSha=${buildInfo.gitSha} builtAt=${buildInfo.builtAt}`,
  );

  const entryPoints = watchMode
    ? [path.resolve(artifactDir, "src/index.ts")]
    : [
        path.resolve(artifactDir, "src/index.ts"),
        path.resolve(artifactDir, "src/seed.ts"),
        path.resolve(artifactDir, "src/backfill-vulnrap-cli.ts"),
        path.resolve(artifactDir, "src/backfill-avri-family.ts"),
        path.resolve(artifactDir, "src/backfill-fabricated-evidence.ts"),
        path.resolve(artifactDir, "src/backfill-engine-versions.ts"),
        path.resolve(artifactDir, "src/remedis-harness.ts"),
      ];

  const buildOptions = {
    entryPoints,
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      // Task #666 — @resvg/resvg-js loads platform-specific .node binaries
      // via require(); externalising the JS wrapper + the prebuilt platform
      // packages lets esbuild skip both the wrapper and the .node files
      // entirely (rather than tripping on the .node loader for the linux
      // build).
      "@resvg/resvg-js",
      "@resvg/resvg-js-*",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    define: {
      "process.env.VULNRAP_PROJECT_VERSION": JSON.stringify(buildInfo.projectVersion),
      "process.env.VULNRAP_SPEC_VERSION": JSON.stringify(buildInfo.specVersion),
      "process.env.VULNRAP_GIT_SHA": JSON.stringify(buildInfo.gitSha),
      "process.env.VULNRAP_BUILT_AT": JSON.stringify(buildInfo.builtAt),
    },
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  };

  if (watchMode) {
    buildOptions.logLevel = "warning";
    buildOptions.plugins.push(makeRestartPlugin());
    const ctx = await esbuildContext(buildOptions);
    await ctx.watch();
    // Keep the process alive; the restart plugin owns the child server.
  } else {
    await esbuild(buildOptions);
  }
}

async function copyOpenApiSpec() {
  const specSrc = path.resolve(
    artifactDir,
    "..",
    "..",
    "lib",
    "api-spec",
    "openapi.yaml",
  );
  const specDst = path.resolve(artifactDir, "dist", "openapi.yaml");
  try {
    await copyFile(specSrc, specDst);
  } catch {
    console.warn("Could not copy openapi.yaml to dist/");
  }
}

buildAll()
  .then(async () => {
    // In watch mode, the dev-restart plugin copies the spec after each
    // successful build (the first run included), so we skip it here to avoid
    // racing the initial build and emitting a "Could not copy openapi.yaml"
    // warning before dist/ exists.
    if (!watchMode) {
      await copyOpenApiSpec();
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
