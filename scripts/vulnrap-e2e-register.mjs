#!/usr/bin/env node
// Task #353 -- Conditional registration of the vulnrap-e2e validation step.
//
// The selector (vulnrap-e2e-select-specs.mjs) prints ALL/NONE/<subset> for
// the current diff. This module re-uses that decision to choose between
// registering the validation step (action="register") or clearing it
// (action="clear"). On a NONE diff the agent calls clearValidationCommand
// instead of setValidationCommand, so the validation dashboard shows the
// step as skipped/not-applicable rather than "passed in 8s with 0 specs".
//
// Two entry points:
//   - syncVulnrapE2eValidation({ setValidationCommand, clearValidationCommand })
//     for the agent's code_execution sandbox (the validation callbacks are
//     not available from a plain Node script).
//   - CLI: prints REGISTER|CLEAR on stdout, reasoning on stderr. Useful
//     for local debugging or a future CI lane.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeChangedFiles,
  listSpecs,
  selectSpecs,
} from "./vulnrap-e2e-select-specs.mjs";

export const VULNRAP_E2E_VALIDATION_NAME = "vulnrap-e2e";
export const VULNRAP_E2E_VALIDATION_COMMAND = "scripts/vulnrap-e2e-check.sh";

/**
 * Map a selector result to a register/clear decision.
 *
 * @param {{mode:"all"|"none"|"subset", reason?:string, specs?:string[]} | null} selectorResult
 *   selectSpecs() output, or null if the diff itself was unavailable.
 * @returns {{action:"register"|"clear", mode:"all"|"subset"|"none", reason:string, specs?:string[]}}
 */
export function decideFromSelectorResult(selectorResult) {
  if (selectorResult == null) {
    return {
      action: "register",
      mode: "all",
      reason: "git diff unavailable -- registering the full suite",
    };
  }
  if (selectorResult.mode === "none") {
    return {
      action: "clear",
      mode: "none",
      reason: selectorResult.reason ?? "no vulnrap e2e surface area touched",
    };
  }
  if (selectorResult.mode === "subset") {
    return {
      action: "register",
      mode: "subset",
      reason: `${selectorResult.specs?.length ?? 0} change-affected spec(s): ${(selectorResult.specs ?? []).join(", ")}`,
      specs: selectorResult.specs,
    };
  }
  return {
    action: "register",
    mode: "all",
    reason: selectorResult.reason ?? "full suite required",
  };
}

/**
 * Read the live diff and return the resulting register/clear decision.
 *
 * @param {{selectorResult?: ReturnType<typeof selectSpecs> | null}} [opts]
 *   Test seam: pass a precomputed selectorResult to bypass git.
 */
export function decideRegistration(opts = {}) {
  if ("selectorResult" in opts) {
    return decideFromSelectorResult(opts.selectorResult);
  }
  const changedFiles = computeChangedFiles();
  if (changedFiles === null) {
    return decideFromSelectorResult(null);
  }
  return decideFromSelectorResult(selectSpecs(changedFiles, listSpecs()));
}

/**
 * Apply the register/clear decision via the validation skill callbacks.
 * The callbacks live in the agent's code_execution sandbox and must be
 * passed in.
 *
 * @param {object} opts
 * @param {(args:{name:string, command:string}) => Promise<unknown>} opts.setValidationCommand
 * @param {(args:{name:string}) => Promise<unknown>} opts.clearValidationCommand
 * @param {string} [opts.name]
 * @param {string} [opts.command]
 * @param {ReturnType<typeof decideRegistration>} [opts.decision]
 *   Test seam: skip the live diff and apply this precomputed decision.
 */
export async function syncVulnrapE2eValidation({
  setValidationCommand,
  clearValidationCommand,
  name = VULNRAP_E2E_VALIDATION_NAME,
  command = VULNRAP_E2E_VALIDATION_COMMAND,
  decision,
} = {}) {
  if (typeof setValidationCommand !== "function") {
    throw new TypeError(
      "syncVulnrapE2eValidation: setValidationCommand callback is required",
    );
  }
  if (typeof clearValidationCommand !== "function") {
    throw new TypeError(
      "syncVulnrapE2eValidation: clearValidationCommand callback is required",
    );
  }
  const d = decision ?? decideRegistration();
  if (d.action === "clear") {
    await clearValidationCommand({ name });
    return { ...d, applied: { action: "clear", name } };
  }
  await setValidationCommand({ name, command });
  return { ...d, applied: { action: "register", name, command } };
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const d = decideRegistration();
  console.error(
    `[vulnrap-e2e-register] -> ${d.action.toUpperCase()} (${d.reason})`,
  );
  console.log(d.action === "clear" ? "CLEAR" : "REGISTER");
}
