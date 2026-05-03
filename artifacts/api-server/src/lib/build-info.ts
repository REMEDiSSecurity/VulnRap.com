/**
 * Build-time injected version metadata, exposed via `GET /api/version`
 * and Task #728's release-process docs.
 *
 * Values are baked in by `build.mjs` via esbuild's `define` option using
 * `process.env.*` keys at *build* time (resolved from git + the manifests
 * in the build environment). At runtime the bundle reads these constants
 * directly — no runtime env-var lookup, no FS reads. The dev-server (no
 * bundling) falls back to the live env vars and finally to dev sentinels
 * so `pnpm dev` keeps working.
 */
export interface BuildInfo {
  project: string;
  projectVersion: string;
  gitSha: string;
  specVersion: string;
  builtAt: string;
}

const PROJECT_NAME = "vulnrap";

function readBaked(key: string, fallback: string): string {
  const v = process.env[key];
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

export function getBuildInfo(): BuildInfo {
  return {
    project: PROJECT_NAME,
    projectVersion: readBaked("VULNRAP_PROJECT_VERSION", "0.0.0-dev"),
    gitSha: readBaked("VULNRAP_GIT_SHA", "dev"),
    specVersion: readBaked("VULNRAP_SPEC_VERSION", "0.0.0-dev"),
    builtAt: readBaked("VULNRAP_BUILT_AT", new Date(0).toISOString()),
  };
}
