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
        {
          // #658 — socket.io dispatches a listener from process.nextTick with no
          // try/catch, so a handler that throws or rejects crashes the process.
          selector: "CallExpression[callee.object.name='socket'][callee.property.name='on']",
          message:
            "Register socket handlers with onClientEvent(socket, event, handler) from server/src/lib/socket/client-event-handler.ts: a throwing or rejecting socket.on handler crashes the API process (#658).",
        },
      ],
    },
  },
  {
    // #346 review round 2 — a KEYED `.partial({ k: true })` over a defaulted
    // key fills it just the same. Route files hold no keyed partial today, so
    // ban every `.partial(` there. packages/shared keeps its keyed create/
    // storage partials (none is a PATCH schema); its exported update*/patch*
    // schemas are guarded by zod-patch.test.ts instead. This block REPLACES the
    // one above for routes (flat config), so it must match zero-arg calls too.
    files: ["server/src/routes/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='partial']",
          message:
            "Use patchSchemaOf(schema) from @metis/shared instead of .partial() / .partial({...}) in a route: under zod 4 .partial() still applies inner .default()s, so a PATCH overwrites omitted fields (#346).",
        },
        {
          // #658 — socket.io dispatches a listener from process.nextTick with no
          // try/catch, so a handler that throws or rejects crashes the process.
          selector: "CallExpression[callee.object.name='socket'][callee.property.name='on']",
          message:
            "Register socket handlers with onClientEvent(socket, event, handler) from server/src/lib/socket/client-event-handler.ts: a throwing or rejecting socket.on handler crashes the API process (#658).",
        },
      ],
    },
  },
);
