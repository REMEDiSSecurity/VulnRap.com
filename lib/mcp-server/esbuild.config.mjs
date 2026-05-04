import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/bundle.js",
  banner: { js: "" },
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

const code = readFileSync("dist/bundle.js", "utf8");
const stripped = code.replace(/^#!.*\n/gm, "");
writeFileSync("dist/bundle.js", "#!/usr/bin/env node\n" + stripped);
