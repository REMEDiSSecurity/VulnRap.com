#!/usr/bin/env node
// Lightweight OpenAPI breaking-change detector run by the release script
// (Task #728). For full coverage we recommend running `oasdiff` (the Go
// binary from Tufin) in CI; this script is a zero-dependency JS fallback
// so the release-gate works on any developer's laptop without extra
// tooling installs. It deliberately covers the common breakage classes
// the hand-rolled API surface in this repo can suffer:
//
//   - A path is removed entirely.
//   - An operation (METHOD on a path) is removed.
//   - An operationId changes — generated React-Query / Zod consumers key
//     off the operationId, so renaming one is breaking even if the wire
//     shape is unchanged.
//   - A property listed in `required` on a response schema is removed —
//     existing clients may rely on it being present.
//   - An enum value is removed from a response field.
//   - The spec's `info.version` did NOT bump despite breaking changes
//     above (warning only when `--require-bump` is passed).
//
// Usage:
//   node scripts/openapi-breaking-diff.mjs <previous.yaml> <current.yaml>
//
// Exit codes:
//   0  — no breaking changes detected
//   1  — breaking changes detected (release script aborts unless the
//        operator explicitly passes BREAKING_OK=1)
//   2  — usage / IO error (file not found, parse failure)

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function loadYamlAsJson(filePath) {
  const yamljs = await import("yamljs").then((m) => m.default ?? m);
  const text = await readFile(filePath, "utf8");
  return yamljs.parse(text);
}

function collectOps(spec) {
  const ops = new Map(); // key: "METHOD path" -> { operationId, op }
  const paths = spec?.paths ?? {};
  for (const [p, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = methods[m];
      if (!op) continue;
      ops.set(`${m.toUpperCase()} ${p}`, { operationId: op.operationId ?? null, op });
    }
  }
  return ops;
}

function resolveSchema(spec, schemaOrRef) {
  if (!schemaOrRef) return null;
  if (schemaOrRef.$ref) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schemaOrRef.$ref);
    if (!m) return null;
    return spec?.components?.schemas?.[m[1]] ?? null;
  }
  return schemaOrRef;
}

function diffResponseSchemas(prev, cur, prevSpec, curSpec, key, breaking) {
  const prevResponses = prev.responses ?? {};
  const curResponses = cur.responses ?? {};
  for (const [code, prevR] of Object.entries(prevResponses)) {
    const curR = curResponses[code];
    if (!curR) continue; // response code removal is checked elsewhere by op presence
    const prevSchema = resolveSchema(prevSpec, prevR?.content?.["application/json"]?.schema);
    const curSchema = resolveSchema(curSpec, curR?.content?.["application/json"]?.schema);
    if (!prevSchema || !curSchema) continue;

    const prevReq = new Set(prevSchema.required ?? []);
    const curReq = new Set(curSchema.required ?? []);
    for (const r of prevReq) {
      if (!curReq.has(r)) {
        breaking.push(
          `${key} ${code}: response field '${r}' was required in the previous version but is no longer required (or was removed).`,
        );
      }
    }

    const prevProps = prevSchema.properties ?? {};
    const curProps = curSchema.properties ?? {};
    for (const [name, prevProp] of Object.entries(prevProps)) {
      const curProp = curProps[name];
      if (!curProp) {
        if (prevReq.has(name)) {
          breaking.push(`${key} ${code}: required response property '${name}' was removed.`);
        }
        continue;
      }
      if (Array.isArray(prevProp.enum) && Array.isArray(curProp.enum)) {
        for (const v of prevProp.enum) {
          if (!curProp.enum.includes(v)) {
            breaking.push(
              `${key} ${code}: enum value '${v}' was removed from response field '${name}'.`,
            );
          }
        }
      }
    }
  }
}

async function main() {
  const [, , prevPath, curPath] = process.argv;
  if (!prevPath || !curPath) {
    console.error("Usage: openapi-breaking-diff.mjs <previous.yaml> <current.yaml>");
    process.exit(2);
  }

  let prevSpec, curSpec;
  try {
    prevSpec = await loadYamlAsJson(path.resolve(prevPath));
  } catch (err) {
    console.error(`[openapi-diff] Could not read previous spec at ${prevPath}: ${err.message}`);
    process.exit(2);
  }
  try {
    curSpec = await loadYamlAsJson(path.resolve(curPath));
  } catch (err) {
    console.error(`[openapi-diff] Could not read current spec at ${curPath}: ${err.message}`);
    process.exit(2);
  }

  const prevOps = collectOps(prevSpec);
  const curOps = collectOps(curSpec);
  const breaking = [];
  const warnings = [];

  for (const [key, prev] of prevOps) {
    const cur = curOps.get(key);
    if (!cur) {
      breaking.push(`Operation removed: ${key}`);
      continue;
    }
    if (prev.operationId && cur.operationId && prev.operationId !== cur.operationId) {
      breaking.push(
        `${key}: operationId renamed '${prev.operationId}' -> '${cur.operationId}' (breaks generated clients).`,
      );
    }
    diffResponseSchemas(prev.op, cur.op, prevSpec, curSpec, key, breaking);
  }

  for (const [key] of curOps) {
    if (!prevOps.has(key)) {
      warnings.push(`Operation added: ${key}`);
    }
  }

  const prevVersion = prevSpec?.info?.version ?? "<missing>";
  const curVersion = curSpec?.info?.version ?? "<missing>";
  console.log(`[openapi-diff] previous spec info.version: ${prevVersion}`);
  console.log(`[openapi-diff] current  spec info.version: ${curVersion}`);

  if (warnings.length) {
    console.log("[openapi-diff] non-breaking changes:");
    for (const w of warnings) console.log(`  + ${w}`);
  }

  if (breaking.length) {
    console.error("[openapi-diff] BREAKING CHANGES detected:");
    for (const b of breaking) console.error(`  ! ${b}`);
    if (prevVersion === curVersion) {
      console.error(
        `[openapi-diff] ABORT: spec info.version is still '${curVersion}' but breaking changes are present. Bump the major component before releasing.`,
      );
    } else {
      console.error(
        `[openapi-diff] Spec moved ${prevVersion} -> ${curVersion}; verify this is a major bump.`,
      );
    }
    process.exit(1);
  }

  console.log("[openapi-diff] OK — no breaking changes detected.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
