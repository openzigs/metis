import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is a thin boot script (createServer + signal handlers);
      // it has no branchable logic and is exercised by `pnpm start`, not by
      // the unit-test gate.
      exclude: ["src/index.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
