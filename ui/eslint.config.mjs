// Local ESLint config for the UI workspace. Adds JSX/React parser options so
// `eslint .` from the repo root can lint .tsx files. We keep this minimal:
// `pnpm lint` at the repo root is the gate. Next 16 removed `next lint` and
// build-time linting, and no Next.js rule set is loaded here, so the unused
// eslint-config-next devDependency was dropped (#1306).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      // Isolated dev/build dir used by the Playwright e2e UI server
      // (NEXT_DIST_DIR in playwright.config.ts) — generated output, never linted.
      ".next-e2e/**",
      ".next-e2e-*/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      "src/components/ui/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2023,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn",
    },
  },
);
