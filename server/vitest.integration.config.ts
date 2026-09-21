/**
 * Issue #323 — Vitest config for `*.integration.test.ts` suites.
 *
 * Run with `pnpm test:integration` (sets RUN_INTEGRATION_TESTS=1). These
 * tests exercise real codebases and may take >30s — they are intentionally
 * excluded from the default `pnpm test` to keep CI fast.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
