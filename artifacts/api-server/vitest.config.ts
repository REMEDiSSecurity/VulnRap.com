import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 15000,
    environment: "node",
    globals: true,
  },
});
