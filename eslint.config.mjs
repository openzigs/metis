import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.next-e2e/**",
      "**/.next-e2e-*/**",
      "**/coverage/**",
      "server/data/repo-clones/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "ui/next-env.d.ts",
      "ui/src/components/ui/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
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
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn",
    },
  },
  {
    // #346 — under zod 4 `.partial()` still fills an inner `.default()` for an
    // absent key, so a PATCH schema built as `createSchema.partial()` overwrote
    // every defaulted stored field the caller left out (renaming a disabled
    // trigger re-enabled it). `patchSchemaOf(schema)` from @metis/shared strips
    // the defaults first and is identical on a default-free schema.
    files: ["server/src/**/*.ts", "packages/shared/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='partial'][arguments.length=0]",
          message:
            "Use patchSchemaOf(schema) from @metis/shared instead of .partial(): under zod 4 .partial() still applies inner .default()s, so a PATCH overwrites omitted fields (#346).",
        },
      ],
    },
  },
);
