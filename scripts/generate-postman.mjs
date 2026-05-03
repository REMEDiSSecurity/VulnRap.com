#!/usr/bin/env node
// Regenerate the VulnRap Postman collection from lib/api-spec/openapi.yaml.
//
// Why this exists:
//   Many integrators evaluate APIs by importing a Postman collection
//   (Insomnia and a long tail of HTTP clients also import the v2.1 format).
//   Hand-maintaining a Postman JSON next to the OpenAPI spec is a recipe
//   for drift, so this script regenerates the collection on demand from
//   the canonical openapi.yaml using the openapi-to-postmanv2 converter.
//
// Output:
//   sdks/postman/vulnrap.postman_collection.json (Postman collection v2.1.0)
//
// Usage:
//   node scripts/generate-postman.mjs
//   pnpm --filter @workspace/scripts run generate:postman
//
// The generated file is checked in so the /developers page can link to a
// stable artifact without users having to clone the repo or run the script.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Converter from "openapi-to-postmanv2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const specPath = path.join(repoRoot, "lib", "api-spec", "openapi.yaml");
const outDir = path.join(repoRoot, "sdks", "postman");
const outPath = path.join(outDir, "vulnrap.postman_collection.json");
// Mirror to artifacts/vulnrap/public so the /developers download link
// resolves at the same origin (no GitHub round-trip).
const publicMirror = path.join(
  repoRoot,
  "artifacts",
  "vulnrap",
  "public",
  "vulnrap.postman_collection.json",
);

async function main() {
  const spec = await readFile(specPath, "utf8");

  const collection = await new Promise((resolve, reject) => {
    Converter.convert(
      { type: "string", data: spec },
      {
        folderStrategy: "Tags",
        requestParametersResolution: "Example",
        exampleParametersResolution: "Example",
        includeAuthInfoInExample: false,
      },
      (err, result) => {
        if (err) return reject(err);
        if (!result || !result.result) {
          return reject(new Error(`conversion failed: ${result?.reason ?? "unknown"}`));
        }
        const out = result.output?.[0];
        if (!out || out.type !== "collection" || !out.data) {
          return reject(new Error("converter returned no collection"));
        }
        resolve(out.data);
      },
    );
  });

  if (collection.info) {
    collection.info.name = "VulnRap API";
    collection.info.description =
      "VulnRap.com — Vulnerability Report Validation Platform. " +
      "Auto-generated from lib/api-spec/openapi.yaml by scripts/generate-postman.mjs. " +
      "Do not edit by hand — re-run the generator instead.";
  }

  collection.variable = [
    {
      key: "baseUrl",
      value: "https://vulnrap.com/api",
      type: "string",
      description: "Base URL for the VulnRap API. Override to point at a self-hosted instance.",
    },
  ];

  const replaceServerVar = (urlObj) => {
    if (!urlObj || typeof urlObj !== "object") return;
    if (Array.isArray(urlObj.host)) {
      urlObj.host = ["{{baseUrl}}"];
      urlObj.protocol = undefined;
      urlObj.port = undefined;
    }
    if (typeof urlObj.raw === "string") {
      urlObj.raw = urlObj.raw.replace(/^\{\{baseUrl\}\}/, "{{baseUrl}}");
    }
  };

  const walk = (items, parentKey) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item.request?.url) replaceServerVar(item.request.url);
      // Replace converter-generated random UUIDs with deterministic ones
      // derived from the item's stable identity (parent folder + name +
      // method + path) so re-running the generator against an unchanged
      // spec produces a byte-identical file. Without this, every run
      // churns ~60 ids and makes real spec drift impossible to review.
      const identity = [
        parentKey ?? "",
        item.name ?? "",
        item.request?.method ?? "",
        item.request?.url?.path?.join("/") ?? "",
      ].join("|");
      if (item.id) item.id = stableUuid(identity);
      if (Array.isArray(item.response)) {
        for (const resp of item.response) {
          if (resp.id) resp.id = stableUuid(identity + "|response|" + (resp.name ?? resp.code ?? ""));
          if (resp.originalRequest?.url) replaceServerVar(resp.originalRequest.url);
        }
      }
      if (Array.isArray(item.item)) walk(item.item, identity);
    }
  };
  walk(collection.item, "");
  if (collection.info?._postman_id) {
    collection.info._postman_id = stableUuid("vulnrap-collection-root");
  }

  const json = JSON.stringify(collection, null, 2) + "\n";
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, json, "utf8");
  await mkdir(path.dirname(publicMirror), { recursive: true });
  await writeFile(publicMirror, json, "utf8");

  const requestCount = countRequests(collection.item);
  console.log(
    `[generate-postman] wrote ${path.relative(repoRoot, outPath)} and ` +
      `${path.relative(repoRoot, publicMirror)} ` +
      `(${requestCount} requests, ${collection.item?.length ?? 0} folders)`,
  );
}

function countRequests(items) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const item of items) {
    if (item.request) n += 1;
    if (Array.isArray(item.item)) n += countRequests(item.item);
  }
  return n;
}

function stableUuid(seed) {
  const h = createHash("sha256").update(seed).digest("hex");
  // Format as a v4-shaped UUID: 8-4-4-4-12. Set version nibble to 4 and
  // variant nibble to 8 for cosmetic conformance with what Postman emits.
  return (
    h.slice(0, 8) + "-" +
    h.slice(8, 12) + "-" +
    "4" + h.slice(13, 16) + "-" +
    "8" + h.slice(17, 20) + "-" +
    h.slice(20, 32)
  );
}

main().catch((err) => {
  console.error("[generate-postman] failed:", err);
  process.exit(1);
});
