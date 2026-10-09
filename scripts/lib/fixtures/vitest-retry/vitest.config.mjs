// #964 — a self-contained vitest project spawned by `vitest-retry-runner.test.mjs`.
// It mirrors `server/vitest.config.ts`: `retry: 2` and the retry reporter beside
// `default`. Its test files end in `.fixture.mjs` so the scripts package's own
// `lib/**/*.test.mjs` glob never collects them.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.fixture.mjs"],
    retry: 2,
    reporters: [
      "default",
      fileURLToPath(new URL("../../vitest-retry-reporter.mjs", import.meta.url)),
    ],
  },
});
