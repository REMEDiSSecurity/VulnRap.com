#!/usr/bin/env node
// Fail loudly when the hand-mirrored Go SDK types drift from the
// canonical OpenAPI spec. The Go SDK at `sdks/go/vulnrap/` re-declares
// a subset of the response shapes (ReportAnalysis, CheckResult,
// PlatformStats, ScoreBreakdown) so it can stay zero-dependency. If
// `lib/api-spec/openapi.yaml` drops, renames, or retypes a `required`
// field, JSON unmarshal silently leaves the matching Go field at its
// zero value -- and `go test` keeps passing because the test fixtures
// are hand-rolled in the same drift. This script is the safety net:
// every required field on the four exposed schemas must map to a Go
// struct field with the right JSON tag and a type-compatible Go type.
//
// Wired into the root `typecheck` script (which CI runs on every PR)
// alongside `verify:codegen`, so a spec edit that forgets to update the
// Go SDK fails the same job that would catch a missed orval regen.
//
// Usage: node scripts/check-go-sdk-openapi-drift.mjs
// Exit codes:
//   0  no drift detected
//   1  drift detected (one or more required fields missing/renamed/retyped)
//   2  internal error (spec or types.go could not be parsed)

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(REPO_ROOT, "lib", "api-spec", "openapi.yaml");
const TYPES_PATH = path.join(
  REPO_ROOT,
  "sdks",
  "go",
  "vulnrap",
  "types.go",
);

// Schemas the Go SDK exposes as typed struct fields. Drift here turns
// silently into zero-value Go fields on the consumer side, which is the
// exact bug class this check exists to prevent.
export const CHECKS = [
  { schema: "ReportAnalysis", goStruct: "ReportAnalysis" },
  { schema: "CheckResult", goStruct: "CheckResult" },
  { schema: "PlatformStats", goStruct: "PlatformStats" },
  { schema: "ScoreBreakdown", goStruct: "ScoreBreakdown" },
];

async function loadSpec(specPath = SPEC_PATH) {
  const yamljs = await import("yamljs").then((m) => m.default ?? m);
  const text = await readFile(specPath, "utf8");
  return yamljs.parse(text);
}

// Parse `type X struct { ... }` blocks out of types.go. We don't need a
// real Go parser -- the SDK uses a single flat layout and gofmt keeps
// the formatting predictable, so a focused regex covers every field
// the SDK ships today and any future field added in the same style.
export function parseGoStructs(source) {
  const structs = new Map(); // name -> [{ goField, goType, jsonTag, omitempty }]
  const re = /type\s+(\w+)\s+struct\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      // Match: GoFieldName GoType `json:"name,omitempty"`
      const fm = /^(\w+)\s+([^`]+?)\s+`([^`]+)`/.exec(line);
      if (!fm) continue;
      const tagBlock = fm[3];
      const jsonTagMatch = /json:"([^"]+)"/.exec(tagBlock);
      if (!jsonTagMatch) continue;
      const tagParts = jsonTagMatch[1].split(",");
      const jsonName = tagParts[0];
      if (jsonName === "-") continue;
      fields.push({
        goField: fm[1],
        goType: fm[2].trim(),
        jsonTag: jsonName,
        omitempty: tagParts.includes("omitempty"),
      });
    }
    structs.set(name, fields);
  }
  return structs;
}

// Reduce an OpenAPI property schema down to a coarse category we can
// compare against a Go type. Handles the OpenAPI 3.1 union-type syntax
// (`type: ["integer", "null"]`) and `oneOf: [..., {type: "null"}]`
// nullable refs since both appear in our spec.
function describeProp(prop) {
  if (!prop || typeof prop !== "object") {
    return { category: "unknown", nullable: false };
  }
  let nullable = prop.nullable === true;
  let type = prop.type;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes("null");
    type = type.find((t) => t !== "null");
  }
  if (prop.$ref) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(prop.$ref);
    return { category: m ? `ref:${m[1]}` : "unknown", nullable };
  }
  const variants = prop.oneOf || prop.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const hasNull = variants.some(
      (v) =>
        v &&
        (v.type === "null" ||
          (Array.isArray(v.type) && v.type.includes("null"))),
    );
    nullable = nullable || hasNull;
    const refVariant = variants.find((v) => v && v.$ref);
    if (refVariant) {
      const m = /^#\/components\/schemas\/(.+)$/.exec(refVariant.$ref);
      return { category: m ? `ref:${m[1]}` : "unknown", nullable };
    }
    const concrete = variants.find((v) => v && v.type && v.type !== "null");
    if (concrete) return { category: concrete.type, nullable };
  }
  if (!type) return { category: "unknown", nullable };
  return { category: type, nullable };
}

// Compatibility check is intentionally loose: we want to catch
// renamed/retyped drift, not flag stylistic differences (e.g. `*int`
// vs `int` for nullable fields, or `time.Time` for date-time strings).
export function isGoTypeCompatible(goType, descriptor) {
  const trimmed = goType.replace(/^\*/, "");
  const cat = descriptor.category;
  if (cat.startsWith("ref:")) {
    const refName = cat.slice("ref:".length);
    // Either the exact ref name or a Go alias that ends in it. The Go
    // SDK happens to use 1:1 names today; the suffix match leaves room
    // for future renames like `vulnrap.ScoreBreakdown`.
    return trimmed === refName || trimmed.endsWith(refName);
  }
  switch (cat) {
    case "integer":
      return /^(int|int32|int64|uint|uint32|uint64)$/.test(trimmed);
    case "number":
      return /^(float32|float64)$/.test(trimmed);
    case "boolean":
      return trimmed === "bool";
    case "string":
      // Allow `time.Time` for `format: date-time` and string-derived
      // enums (e.g. `type ContentMode string`).
      return (
        trimmed === "string" ||
        trimmed === "time.Time" ||
        /^[A-Z]\w*$/.test(trimmed)
      );
    case "array":
      return trimmed.startsWith("[]");
    case "object":
      // `map[K]V` for `additionalProperties` schemas, or a named struct
      // for inline object schemas (e.g. PlatformStats.reportsByMode).
      return trimmed.startsWith("map[") || /^[A-Z]\w*$/.test(trimmed);
    case "unknown":
      return true; // OpenAPI didn't pin a type — can't judge.
    default:
      return true;
  }
}

function describeOpenApiType(prop) {
  if (!prop) return "unknown";
  if (prop.$ref) return prop.$ref.replace("#/components/schemas/", "");
  if (Array.isArray(prop.type)) return prop.type.join("|");
  if (prop.oneOf) return "oneOf";
  if (prop.anyOf) return "anyOf";
  return prop.type ?? "unknown";
}

export function findDrift(spec, source, checks = CHECKS) {
  const structs = parseGoStructs(source);
  const errors = [];

  for (const { schema, goStruct } of checks) {
    const schemaDef = spec?.components?.schemas?.[schema];
    if (!schemaDef) {
      errors.push(
        `OpenAPI schema '${schema}' not found in lib/api-spec/openapi.yaml.`,
      );
      continue;
    }
    const goFields = structs.get(goStruct);
    if (!goFields) {
      errors.push(
        `Go struct '${goStruct}' not found in sdks/go/vulnrap/types.go.`,
      );
      continue;
    }
    const required = schemaDef.required ?? [];
    const properties = schemaDef.properties ?? {};
    const byTag = new Map(goFields.map((f) => [f.jsonTag, f]));

    for (const reqName of required) {
      const prop = properties[reqName];
      if (!prop) {
        errors.push(
          `${schema}.${reqName}: listed in 'required' but missing from 'properties' (fix lib/api-spec/openapi.yaml).`,
        );
        continue;
      }
      const goField = byTag.get(reqName);
      if (!goField) {
        errors.push(
          `${schema}.${reqName}: required by the OpenAPI spec but no Go field has \`json:"${reqName}"\` on ${goStruct} (sdks/go/vulnrap/types.go). ` +
            `The Go SDK will silently return the zero value for this field.`,
        );
        continue;
      }
      const desc = describeProp(prop);
      if (!isGoTypeCompatible(goField.goType, desc)) {
        errors.push(
          `${schema}.${reqName}: OpenAPI type '${describeOpenApiType(prop)}' ` +
            `is not compatible with Go field ${goStruct}.${goField.goField} (${goField.goType}). ` +
            `Update sdks/go/vulnrap/types.go to match the spec.`,
        );
      }
    }

    // Reverse direction: every Go field that claims to mirror the spec
    // must still correspond to a property in the schema. This is the
    // half that catches the "spec dropped/renamed a field but the Go
    // SDK still has the old struct field" case — without it, stale Go
    // fields silently unmarshal to zero values and the check passes.
    const propertyNames = new Set(Object.keys(properties));
    for (const f of goFields) {
      if (propertyNames.has(f.jsonTag)) continue;
      errors.push(
        `${goStruct}.${f.goField} (json:"${f.jsonTag}") has no matching property on OpenAPI schema '${schema}'. ` +
          `The spec likely dropped or renamed this field — update sdks/go/vulnrap/types.go ` +
          `(remove the field, or rename its json tag to match the new spec name).`,
      );
    }
  }
  return errors;
}

async function main() {
  let spec;
  try {
    spec = await loadSpec();
  } catch (err) {
    console.error(
      `check-go-sdk-openapi-drift: failed to read/parse ${path.relative(REPO_ROOT, SPEC_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }
  let source;
  try {
    source = await readFile(TYPES_PATH, "utf8");
  } catch (err) {
    console.error(
      `check-go-sdk-openapi-drift: failed to read ${path.relative(REPO_ROOT, TYPES_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }

  const errors = findDrift(spec, source);
  if (errors.length > 0) {
    console.error("✖ Go SDK <-> OpenAPI drift detected:");
    for (const e of errors) console.error("  - " + e);
    console.error(
      "\nFix sdks/go/vulnrap/types.go to mirror lib/api-spec/openapi.yaml " +
        "(add the missing field with the right `json:\"...\"` tag, rename it, " +
        "or change its Go type), then re-run " +
        "`node scripts/check-go-sdk-openapi-drift.mjs`.",
    );
    process.exit(1);
  }

  const totalRequired = CHECKS.reduce((acc, { schema }) => {
    return acc + (spec.components.schemas[schema]?.required?.length ?? 0);
  }, 0);
  console.log(
    `✔ Go SDK mirrors all ${totalRequired} required OpenAPI fields across ${CHECKS.length} schemas (${CHECKS.map((c) => c.schema).join(", ")}).`,
  );
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(path.basename(process.argv[1] ?? ""));

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("check-go-sdk-openapi-drift: unexpected error:", err);
    process.exit(2);
  });
}
