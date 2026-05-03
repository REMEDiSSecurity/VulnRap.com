#!/usr/bin/env node
// Sanity test for scripts/vulnrap-e2e-register.mjs (Task #353).
// Run: `node scripts/vulnrap-e2e-register.test.mjs` (exit 0 == pass).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VULNRAP_E2E_VALIDATION_NAME,
  VULNRAP_E2E_VALIDATION_COMMAND,
  decideFromSelectorResult,
  decideRegistration,
  syncVulnrapE2eValidation,
} from "./vulnrap-e2e-register.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "vulnrap-e2e-register.mjs");

let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// decideFromSelectorResult: each selector outcome maps to the right action.
{
  const d = decideFromSelectorResult(null);
  check("null -> register/all", d.action === "register" && d.mode === "all");
  check("null reason mentions git diff", /git diff unavailable/.test(d.reason));
}
{
  const d = decideFromSelectorResult({
    mode: "all",
    reason: "shared file changed: X",
  });
  check(
    "mode=all -> register/all",
    d.action === "register" && d.mode === "all",
  );
  check("mode=all reason carried", /shared file changed: X/.test(d.reason));
}
{
  const d = decideFromSelectorResult({
    mode: "subset",
    specs: ["handwavy-undo.spec.ts", "handwavy-remove-confirm.spec.ts"],
  });
  check(
    "mode=subset -> register/subset",
    d.action === "register" && d.mode === "subset",
  );
  check(
    "mode=subset specs carried",
    Array.isArray(d.specs) && d.specs.length === 2,
  );
  check(
    "mode=subset reason names a spec",
    /handwavy-undo\.spec\.ts/.test(d.reason),
  );
}
{
  const d = decideFromSelectorResult({
    mode: "none",
    reason: "no surface area",
  });
  check("mode=none -> clear/none", d.action === "clear" && d.mode === "none");
  check("mode=none reason carried", /no surface area/.test(d.reason));
}

// decideRegistration: selectorResult test seam bypasses git.
{
  const d = decideRegistration({
    selectorResult: { mode: "none", reason: "stub" },
  });
  check(
    "decideRegistration({selectorResult:none}) -> clear",
    d.action === "clear",
  );
}

// Constants surfaced for callers.
check("name constant", VULNRAP_E2E_VALIDATION_NAME === "vulnrap-e2e");
check(
  "command constant",
  VULNRAP_E2E_VALIDATION_COMMAND === "scripts/vulnrap-e2e-check.sh",
);

// syncVulnrapE2eValidation: fail-loud on missing callbacks.
{
  let threw = false;
  try {
    await syncVulnrapE2eValidation({ clearValidationCommand: async () => {} });
  } catch (e) {
    threw = e instanceof TypeError;
  }
  check("missing setValidationCommand -> TypeError", threw);
}
{
  let threw = false;
  try {
    await syncVulnrapE2eValidation({ setValidationCommand: async () => {} });
  } catch (e) {
    threw = e instanceof TypeError;
  }
  check("missing clearValidationCommand -> TypeError", threw);
}

// syncVulnrapE2eValidation: register-path dispatch (forced via decision seam).
{
  const setCalls = [];
  const clearCalls = [];
  const result = await syncVulnrapE2eValidation({
    setValidationCommand: async (a) => void setCalls.push(a),
    clearValidationCommand: async (a) => void clearCalls.push(a),
    decision: { action: "register", mode: "all", reason: "test" },
  });
  check(
    "register dispatch: setValidationCommand called once with name+command",
    setCalls.length === 1 &&
      clearCalls.length === 0 &&
      setCalls[0].name === VULNRAP_E2E_VALIDATION_NAME &&
      setCalls[0].command === VULNRAP_E2E_VALIDATION_COMMAND,
    JSON.stringify({ setCalls, clearCalls }),
  );
  check(
    "register dispatch: result.applied is correct",
    result.applied?.action === "register" &&
      result.applied?.name === VULNRAP_E2E_VALIDATION_NAME,
    JSON.stringify(result.applied),
  );
}

// syncVulnrapE2eValidation: clear-path dispatch (forced via decision seam).
{
  const setCalls = [];
  const clearCalls = [];
  const result = await syncVulnrapE2eValidation({
    setValidationCommand: async (a) => void setCalls.push(a),
    clearValidationCommand: async (a) => void clearCalls.push(a),
    decision: { action: "clear", mode: "none", reason: "test" },
  });
  check(
    "clear dispatch: clearValidationCommand called once with the name",
    clearCalls.length === 1 &&
      setCalls.length === 0 &&
      clearCalls[0].name === VULNRAP_E2E_VALIDATION_NAME,
    JSON.stringify({ setCalls, clearCalls }),
  );
  check(
    "clear dispatch: result.applied is correct",
    result.applied?.action === "clear" &&
      result.applied?.name === VULNRAP_E2E_VALIDATION_NAME,
    JSON.stringify(result.applied),
  );
}

// syncVulnrapE2eValidation: name+command override is forwarded.
{
  let setArgs = null;
  await syncVulnrapE2eValidation({
    setValidationCommand: async (a) => void (setArgs = a),
    clearValidationCommand: async () => {},
    decision: { action: "register", mode: "all", reason: "test" },
    name: "custom-e2e",
    command: "echo overridden",
  });
  check(
    "name+command override forwarded to setValidationCommand",
    setArgs?.name === "custom-e2e" && setArgs?.command === "echo overridden",
    JSON.stringify(setArgs),
  );
}

// CLI: stdout is exactly REGISTER|CLEAR; stderr carries the breadcrumb.
{
  const res = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: process.env,
  });
  const out = (res.stdout ?? "").trim();
  check(
    "CLI: stdout is REGISTER|CLEAR",
    res.status === 0 && (out === "REGISTER" || out === "CLEAR"),
    `status=${res.status} stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`,
  );
  check(
    "CLI: stderr has [vulnrap-e2e-register] breadcrumb",
    /\[vulnrap-e2e-register\] -> (REGISTER|CLEAR)/.test(res.stderr ?? ""),
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
