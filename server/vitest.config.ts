import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Issue #323 — real-repo integration tests live in `*.integration.test.ts`
    // and are gated behind `pnpm test:integration` so the default `pnpm test`
    // run stays fast.
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    // Issue #876 — `setup-datasource.ts` makes the suite run against EITHER generated
    // Prisma client (SQLite or Postgres), removing the `prisma generate` toggle that
    // dev-on-Postgres used to require before every `pnpm test`. It is intentionally NOT
    // listed in `vitest.integration.config.ts`, which must see the real `DATABASE_URL`.
    setupFiles: ["tests/setup.ts", "tests/setup-datasource.ts"],
    // Use forked workers so each test file gets a fresh process. The codebase
    // relies on module-level singletons (MCP registry, agent/skill services,
    // rate limiters, prisma client, etc.) and the default thread pool with
    // vmThreads isolation has surfaced occasional cross-file leaks (#143
    // post-merge flake: connector-routes "socket hang up", mcp-routes
    // "expected 500 to be 401").
    // Integration-style tests (real Express servers, HTTP round-trips) can
    // spike past the 5s default when the runner is under parallel CI load.
    // 15s gives ample headroom without masking genuine hangs.
    testTimeout: 15000,
    // Retry inherently timing/process-sensitive integration tests (real
    // Socket.IO connections, spawned MCP stdio processes, Express HTTP
    // round-trips) that flake intermittently under parallel CI load. Locally
    // these always pass first try; in CI a different one occasionally fails per
    // run (socket.test, mcp-routes, spec-kit-routes — all I/O-timing bound).
    // 2 retries clears the transient failures without masking real regressions
    // (a genuinely broken test fails all 3 attempts).
    retry: 2,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/lib/agents-md/cli.ts",
        "src/lib/auth/ldap-provider.ts",
        "src/lib/auth/oidc-provider.ts",
        "src/lib/auth/saml-provider.ts",
        "src/lib/mcp/cli.ts",
        "src/lib/mcp/types.ts",
        // Issue #579 — thin Slack Bolt SDK-adapter wiring (constructs the
        // ExpressReceiver + registers listeners that delegate to the fully-tested
        // pure handlers). Excluded like the SSO provider adapters above.
        "src/lib/slack/slack-receiver.ts",
        // Issue #335 — the LIVE A/B evaluator wires real local/cloud providers +
        // the FaithfulnessJudge and is only run by an operator against real
        // models (never in CI). The aggregation/gate LOGIC it feeds is fully
        // unit-tested with a mocked evaluator. Excluded like the provider adapters.
        "src/lib/eval/hybrid-ab/live-evaluator.ts",
        "src/index.ts",
        "src/server.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
