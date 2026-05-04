#!/usr/bin/env node
// Standalone unit test for scripts/check-go-sdk-openapi-drift.mjs.
// Builds a tiny synthetic spec + types.go in memory and asserts that
// the drift detector flags the four bug classes the real check exists
// to catch (missing required field, renamed JSON tag, retyped Go field,
// added required field on a future spec). Wired into the scripts
// package's `test` script so root `pnpm test` exercises it on every PR.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findDrift, parseGoStructs, isGoTypeCompatible } from "./check-go-sdk-openapi-drift.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// Synthetic spec: a single `Demo` schema with three required fields.
const baseSpec = {
  components: {
    schemas: {
      Demo: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          score: { type: "number" },
        },
        required: ["id", "name", "score"],
      },
    },
  },
};
const baseGo = `
package vulnrap

type Demo struct {
        ID    int     \`json:"id"\`
        Name  string  \`json:"name"\`
        Score float64 \`json:"score"\`
}
`;
const checks = [{ schema: "Demo", goStruct: "Demo" }];

// 1. Baseline: no drift.
{
  const errs = findDrift(baseSpec, baseGo, checks);
  check("baseline reports no drift", errs.length === 0, errs.join("\n"));
}

// 2. Missing required field: drop `Score` from the Go struct.
{
  const goMissing = `
package vulnrap
type Demo struct {
        ID   int    \`json:"id"\`
        Name string \`json:"name"\`
}
`;
  const errs = findDrift(baseSpec, goMissing, checks);
  check(
    "missing required field is flagged",
    errs.length === 1 && /score/.test(errs[0]) && /no Go field/.test(errs[0]),
    errs.join("\n"),
  );
}

// 3. Renamed JSON tag: Go field exists but with a different json tag.
{
  const goRenamed = `
package vulnrap
type Demo struct {
        ID    int     \`json:"id"\`
        Name  string  \`json:"displayName"\`
        Score float64 \`json:"score"\`
}
`;
  const errs = findDrift(baseSpec, goRenamed, checks);
  // Renames trip both directions: forward sees the required `name`
  // missing; reverse sees `displayName` with no matching spec property.
  check(
    "renamed JSON tag is flagged in both directions",
    errs.length === 2 &&
      errs.some((e) => /no Go field has `json:"name"`/.test(e)) &&
      errs.some((e) => /json:"displayName"/.test(e) && /no matching property/.test(e)),
    errs.join("\n"),
  );
}

// 3b. Reverse drift: spec dropped a field but Go still has it.
{
  const goWithStaleField = `
package vulnrap
type Demo struct {
        ID         int     \`json:"id"\`
        Name       string  \`json:"name"\`
        Score      float64 \`json:"score"\`
        LegacyFlag bool    \`json:"legacyFlag,omitempty"\`
}
`;
  const errs = findDrift(baseSpec, goWithStaleField, checks);
  check(
    "Go field with no matching spec property is flagged (drop/rename)",
    errs.length === 1 &&
      /Demo\.LegacyFlag/.test(errs[0]) &&
      /no matching property/.test(errs[0]),
    errs.join("\n"),
  );
}

// 4. Retyped Go field: integer in spec, string in Go.
{
  const goRetyped = `
package vulnrap
type Demo struct {
        ID    string  \`json:"id"\`
        Name  string  \`json:"name"\`
        Score float64 \`json:"score"\`
}
`;
  const errs = findDrift(baseSpec, goRetyped, checks);
  check(
    "retyped Go field is flagged",
    errs.length === 1 && /id/.test(errs[0]) && /not compatible/.test(errs[0]),
    errs.join("\n"),
  );
}

// 5. Newly required field added to the spec is flagged when Go lags.
{
  const newSpec = {
    components: {
      schemas: {
        Demo: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            score: { type: "number" },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id", "name", "score", "createdAt"],
        },
      },
    },
  };
  const errs = findDrift(newSpec, baseGo, checks);
  check(
    "newly-required spec field is flagged",
    errs.length === 1 && /createdAt/.test(errs[0]),
    errs.join("\n"),
  );
}

// 6. Type compatibility helpers: the loose rules we rely on.
check(
  "*int is compatible with nullable integer",
  isGoTypeCompatible("*int", { category: "integer", nullable: true }),
);
check(
  "time.Time is compatible with string",
  isGoTypeCompatible("time.Time", { category: "string", nullable: false }),
);
check(
  "ContentMode (string-derived enum) is compatible with string",
  isGoTypeCompatible("ContentMode", { category: "string", nullable: false }),
);
check(
  "[]EvidenceItem is compatible with array",
  isGoTypeCompatible("[]EvidenceItem", { category: "array", nullable: false }),
);
check(
  "map[string]string is compatible with object",
  isGoTypeCompatible("map[string]string", { category: "object", nullable: false }),
);
check(
  "string is NOT compatible with integer",
  !isGoTypeCompatible("string", { category: "integer", nullable: false }),
);

// 7. parseGoStructs handles pointer + slice + qualified types.
{
  const structs = parseGoStructs(`
type Mixed struct {
        A *int              \`json:"a,omitempty"\`
        B []EvidenceItem    \`json:"b"\`
        C map[string]string \`json:"c"\`
        D time.Time         \`json:"d"\`
}
`);
  const fields = structs.get("Mixed") ?? [];
  const byName = Object.fromEntries(fields.map((f) => [f.goField, f]));
  check(
    "parseGoStructs reads pointer field",
    byName.A?.goType === "*int" && byName.A?.omitempty === true,
  );
  check(
    "parseGoStructs reads slice field",
    byName.B?.goType === "[]EvidenceItem" && byName.B?.jsonTag === "b",
  );
  check(
    "parseGoStructs reads map field",
    byName.C?.goType === "map[string]string",
  );
  check(
    "parseGoStructs reads qualified type",
    byName.D?.goType === "time.Time",
  );
}

// 8. End-to-end smoke: the real spec + the real types.go must be in
//    sync after this task. If a future spec edit breaks this, the test
//    fails the same way CI's `verify:go-sdk-spec` step would.
{
  const yamljs = await import("yamljs").then((m) => m.default ?? m);
  const specText = await readFile(
    path.join(REPO_ROOT, "lib", "api-spec", "openapi.yaml"),
    "utf8",
  );
  const spec = yamljs.parse(specText);
  const source = await readFile(
    path.join(REPO_ROOT, "sdks", "go", "vulnrap", "types.go"),
    "utf8",
  );
  const errs = findDrift(spec, source);
  check(
    "real spec + real Go SDK are in sync",
    errs.length === 0,
    errs.join("\n"),
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
