import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The one whole-tree acceptance scan runs here, once, outside the timed and
    // parallel pool; see the file's header (#99).
    globalSetup: ["./vitest.global-setup.mjs"],
    include: ["lib/**/*.test.ts", "lib/**/*.test.mjs", "local-llm/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      // NOTE: this scope excludes every top-level entrypoint — `verify-agent-frontmatter.mjs`,
      // `verify-skills.mjs` and the rest are NOT measured, so a percentage on this package is
      // not evidence about runner code and must not be quoted as if it were (#1207). The one
      // mutant that ever survived a sweep on #1206, and the fail-open a reviewer found after
      // it, both lived in a runner. What covers those is the subprocess-executing arms in
      // `lib/verify-agent-frontmatter-runner.test.mjs`, which spawn the real script.
      include: ["lib/**/*.mjs", "local-llm/**/*.mjs"],
      exclude: [
        "lib/**/*.test.*",
        "local-llm/**/*.test.*",
        // `check-no-nul.mjs` is a runner that happens to live in `lib/`: it exports
        // nothing and does its work in top-level statements, so it can only be tested
        // by spawning it — which is what `check-no-nul-runner.test.mjs` does, in seven
        // arms. v8 measures this process, not its children, so the file reports 0% no
        // matter how well it is covered, and every line added to it drags the package
        // aggregate down while making the gate stricter. Counting it was the same
        // category error the NOTE above warns about, just from the other side: a
        // percentage that is not evidence about runner code (#1207, #1215).
        "lib/check-no-nul.mjs",
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
