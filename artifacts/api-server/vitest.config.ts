import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "test/**/*.test.ts",
    ],
    testTimeout: 15000,
    environment: "node",
    globals: true,
  },
});
