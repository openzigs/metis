import tseslint from "typescript-eslint";

// #658 — socket.io dispatches a client event's listeners, and the `connection`
// listener, from process.nextTick with no try/catch, so a listener that throws
// or rejects crashes the API process. Handlers are registered with
// onClientEvent(socket, event, handler) and connection setup with
// onConnection(io, attach) (server/src/lib/socket/client-event-handler.ts).
// Every EventEmitter / socket.io registration method:
const LISTENER_METHODS = "/^(on|once|addListener|prependListener|prependOnceListener|onAny)$/";
const SOCKET_LISTENER_MESSAGE =
  "Register socket listeners with onClientEvent(socket, event, handler) or onConnection(io, attach) from server/src/lib/socket/client-event-handler.ts: a throwing or rejecting listener crashes the API process (#658).";
// Anywhere in server/src: a listener registered on an object named `socket`
// (`socket.on(...)`, `this.socket.once(...)`, ...).
const SOCKET_LISTENER_ANYWHERE = {
  selector: `CallExpression[callee.property.name=${LISTENER_METHODS}]:matches([callee.object.name='socket'], [callee.object.property.name='socket'])`,
  message: SOCKET_LISTENER_MESSAGE,
};
// In the socket modules: a listener registered on ANY object, whatever it is
// called (`s.on`, `client.once`, `io.on("connection")`, `socket.onAny`). One
// allowlisted receiver: `asRelayServer(io).on(...)` in revocation-relay.ts, the
// replica-to-replica `serverSideEmit` relay, which no client can reach and
// whose listener catches its own throw.
const LISTENER_IN_SOCKET_MODULES = {
  selector: `CallExpression[callee.property.name=${LISTENER_METHODS}]:not([callee.object.callee.name='asRelayServer'])`,
  message: SOCKET_LISTENER_MESSAGE,
};
const ZERO_ARG_PARTIAL = {
  selector: "CallExpression[callee.property.name='partial'][arguments.length=0]",
  message:
    "Use patchSchemaOf(schema) from @metis/shared instead of .partial(): under zod 4 .partial() still applies inner .default()s, so a PATCH overwrites omitted fields (#346).",
};

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
      "no-restricted-syntax": ["error", ZERO_ARG_PARTIAL, SOCKET_LISTENER_ANYWHERE],
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
        SOCKET_LISTENER_ANYWHERE,
      ],
    },
  },
  {
    // #658 review — inside the socket modules, ban a listener registration on
    // any receiver (see LISTENER_IN_SOCKET_MODULES). This block REPLACES the
    // server/src one for these files (flat config), so it repeats the #346
    // rule. Exempt: client-event-handler.ts, which implements the wrappers, and
    // cluster-adapter.ts, whose only emitters are the pg Pool and its LISTEN
    // client (`pool.on("error")`, `client.on("error")`, `client.once("end")`),
    // never a socket.io socket.
    files: ["server/src/lib/socket/**/*.ts", "server/src/lib/collaboration/presence.ts"],
    ignores: [
      "**/*.test.ts",
      "server/src/lib/socket/client-event-handler.ts",
      "server/src/lib/socket/cluster-adapter.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ZERO_ARG_PARTIAL, LISTENER_IN_SOCKET_MODULES],
    },
  },
  {
    // #658 review — a promise started mid-handler and discarded with `void` is
    // outside onClientEvent's reach, so in the socket modules it must go
    // through runDetached(work, what, socketId), which logs its rejection.
    // `ignoreVoid: false` is the point: `void` is the escape this rule closes.
    // Type-aware, so typed linting is enabled for these files only.
    files: ["server/src/lib/socket/**/*.ts", "server/src/lib/collaboration/presence.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
    },
  },
);
