// Flat ESLint config for the workspace.
// Covers TypeScript everywhere, React (vulnrap artifact), Node (api-server,
// scripts, lib/*), and Vitest test files. Per-area overrides keep noise low.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import importPlugin from "eslint-plugin-import";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

const tsFiles = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const jsFiles = ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];

export default [
  // 1. Files / directories that should never be linted.
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/out-tsc/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "**/.expo/**",
      "**/.expo-shared/**",
      "lib/api-client-react/src/generated/**",
      "lib/api-zod/src/generated/**",
      "sdks/go/**",
      "sdks/postman/**",
      "sdks/bookmarklet/vulnrap.bookmarklet.js",
      "deploy/helm/**",
      "attached_assets/**",
      "artifacts/*/test-results/**",
      "artifacts/*/playwright-report/**",
      "artifacts/*/playwright/.cache/**",
      "artifacts/*/data/**",
      "artifacts/mockup-sandbox/**",
      ".local/**",
      ".cache/**",
      ".config/**",
      // Hand-rolled bookmarklets are intentionally minified-style ES5.
      "**/vulnrap.bookmarklet.js",
      "sdks/bookmarklet/src/bookmarklet.js",
    ],
  },

  // 2. Baseline JS recommended rules.
  js.configs.recommended,

  // 3. TypeScript recommended rules (non type-checked, fast).
  ...tseslint.configs.recommended,

  // 4. Workspace-wide defaults.
  {
    files: [...tsFiles, ...jsFiles],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: [
            "tsconfig.base.json",
            "artifacts/*/tsconfig.json",
            "lib/*/tsconfig.json",
            "scripts/tsconfig.json",
          ],
        },
        node: true,
      },
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "warn",
      "no-var": "error",
      // Low-noise baseline: keep these as warnings so existing code passes
      // on the first commit. Ratchet to error in follow-up tasks.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-regex-spaces": "warn",
      "no-control-regex": "warn",
      "no-async-promise-executor": "warn",
      "no-prototype-builtins": "warn",
      "no-unused-vars": "off", // handled by typescript-eslint below
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Project-wide rule per CONTRIBUTING.md ("no any without justification").
      // Kept at warn so existing code passes; ratchet to error in a follow-up.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "import/order": [
        "warn",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            ["parent", "sibling", "index"],
            "type",
          ],
          "newlines-between": "ignore",
        },
      ],
    },
  },

  // 5. React (vulnrap frontend) overrides.
  {
    files: ["artifacts/vulnrap/**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/jsx-uses-vars": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },

  // 6a. Prerender / build scripts run via Playwright in a browser context.
  {
    files: [
      "artifacts/vulnrap/scripts/**/*.{js,mjs,cjs}",
      "artifacts/api-server/build.mjs",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // 6. Node-side code (api-server, scripts, lib/*) — keep console allowed.
  {
    files: [
      "artifacts/api-server/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "scripts/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "lib/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "sdks/**/*.{ts,js,mjs,cjs}",
    ],
    rules: {
      "no-console": "off",
    },
  },

  // 7. Test files — relax noise rules.
  {
    files: [
      "**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}",
      "**/*.spec.{ts,tsx,mts,cts,js,mjs,cjs}",
      "**/test/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "**/tests/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "**/e2e/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },

  // 8. Disable formatting-related rules — Prettier owns formatting.
  prettierConfig,
];
