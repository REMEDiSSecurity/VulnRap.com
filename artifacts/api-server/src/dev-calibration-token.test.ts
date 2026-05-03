// Task #330 — regression guard for the dev-only default calibration token
// wired into the two `dev` scripts by Task #232 so the FLAT hand-wavy phrase
// panel loads on `/feedback-analytics` without manual env setup. Asserts:
//   * Both dev scripts still default the token via `${VAR:-<default>}`.
//   * Both scripts share the same default value (so API + Vite client cannot
//     drift to two different tokens).
//   * `requireCalibrationAuthStrict` authenticates a request that presents
//     the captured default token (so the API gate actually accepts it).
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireCalibrationAuthStrict } from "./middlewares/require-calibration-auth";
import type { Request, Response, NextFunction } from "express";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src -> api-server -> artifacts -> repo root
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const API_PKG_PATH = path.join(REPO_ROOT, "artifacts/api-server/package.json");
const WEB_PKG_PATH = path.join(REPO_ROOT, "artifacts/vulnrap/package.json");

async function readDevScript(pkgPath: string): Promise<string> {
  const text = await fs.readFile(pkgPath, "utf8");
  const parsed = JSON.parse(text) as { scripts?: { dev?: string } };
  if (typeof parsed.scripts?.dev !== "string") {
    throw new Error(`expected scripts.dev string in ${pkgPath}`);
  }
  return parsed.scripts.dev;
}

// Match `<NAME>="${<NAME>:-<default>}"` with an optional leading `export `.
// The capture group returns the default value so we can both assert the
// pattern is present and pin the actual token the dev workflow will hand
// to the API process / Vite client.
function extractEnvDefault(script: string, varName: string): string {
  const re = new RegExp(
    `(?:export\\s+)?${varName}="\\$\\{${varName}:-([^}]+)\\}"`,
  );
  const m = re.exec(script);
  if (m === null) {
    throw new Error(
      `dev script does not default ${varName} via \${${varName}:-...}; ` +
        `got: ${script}`,
    );
  }
  return m[1];
}

describe("Task #330 dev calibration-token default (regression guard)", () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.CALIBRATION_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.CALIBRATION_TOKEN;
    } else {
      process.env.CALIBRATION_TOKEN = savedToken;
    }
  });

  it("api-server dev script defaults CALIBRATION_TOKEN via ${CALIBRATION_TOKEN:-...}", async () => {
    const dev = await readDevScript(API_PKG_PATH);
    const defaulted = extractEnvDefault(dev, "CALIBRATION_TOKEN");
    expect(defaulted.length).toBeGreaterThan(0);
  });

  it("vulnrap dev script defaults VITE_CALIBRATION_TOKEN via ${VITE_CALIBRATION_TOKEN:-...}", async () => {
    const dev = await readDevScript(WEB_PKG_PATH);
    const defaulted = extractEnvDefault(dev, "VITE_CALIBRATION_TOKEN");
    expect(defaulted.length).toBeGreaterThan(0);
  });

  it("api-server and vulnrap dev scripts share the SAME default token (so the API gate and the Vite client token cannot drift)", async () => {
    const apiDev = await readDevScript(API_PKG_PATH);
    const webDev = await readDevScript(WEB_PKG_PATH);
    const apiToken = extractEnvDefault(apiDev, "CALIBRATION_TOKEN");
    const webToken = extractEnvDefault(webDev, "VITE_CALIBRATION_TOKEN");
    expect(apiToken).toBe(webToken);
  });

  it("requireCalibrationAuthStrict authenticates a request presenting the dev default token (so the API-side strict-read gate actually allows the panel to load)", async () => {
    const apiDev = await readDevScript(API_PKG_PATH);
    const defaultToken = extractEnvDefault(apiDev, "CALIBRATION_TOKEN");
    process.env.CALIBRATION_TOKEN = defaultToken;

    const headers: Record<string, string> = {
      "x-calibration-token": defaultToken,
    };
    const req = {
      header: (name: string) => headers[name.toLowerCase()],
      ip: "127.0.0.1",
      method: "GET",
      originalUrl: "/feedback/calibration/handwavy-phrases",
    } as unknown as Request;

    let nextCalled = false;
    let statusCode: number | null = null;
    const next: NextFunction = () => {
      nextCalled = true;
    };
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;

    requireCalibrationAuthStrict(req, res, next);

    expect(statusCode).toBeNull();
    expect(nextCalled).toBe(true);
  });
});
