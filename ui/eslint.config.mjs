// Local ESLint config for the UI workspace. Adds JSX/React parser options so
// `eslint .` from the repo root can lint .tsx files. We keep this minimal —
// the typed Next.js rules run only via the Next-aware `next lint` command if
// invoked separately, but `pnpm lint` at the repo root is the gate.
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
