/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
      "@metis/shared": path.resolve(dirname, "../packages/shared/src/index.ts"),
      "@metis/ui-kit": path.resolve(dirname, "../packages/ui-kit/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    css: false,
    // Issue #509 — flake stabilization. The UI suite is async/`waitFor`-heavy and
    // polls on REAL timers (RTL `findBy*` / `waitFor`, Radix portals, React Query
    // resolution). On the shared self-hosted runner the `ui`, `api`, and
    // `sql-lineage` jobs run concurrently, so CPU starvation occasionally pushes a
    // poll past vitest's 5s default — a DIFFERENT unrelated file failed each run
    // (ProjectSwitcher "Loading…", menus, app-shell, workbench-*, connections-*,
    // analysis-collab, test-coverage). The mocks are correct; the budget was too
    // tight under contention. Mirror the server config (server/vitest.config.ts):
    // 15s gives starved polls headroom without masking genuine hangs, and 2 CI-only
    // retries clear transient starvation flakes while still failing a real
    // regression on all 3 attempts. Locally (no CI env) retries stay off so broken
    // tests fail fast.
    testTimeout: 15000,
    hookTimeout: 15000,
    retry: process.env.CI ? 2 : 0,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        // Next.js app-shell pages with no testable logic (pure layouts /
        // redirects / thin wrappers). Use src/app/*/ instead of
        // src/app/(authed)/ because picomatch treats bare parentheses as
        // extglob groups and never matches the literal '(authed)' segment.
        "src/app/page.tsx",
        "src/app/login/page.tsx",
        "src/app/*/admin/page.tsx",
        "src/app/*/admin/mcp/page.tsx",
        "src/app/*/admin/auth/page.tsx",
        "src/app/*/admin/usage/page.tsx",
        "src/app/*/admin/workspaces/**/*.tsx",
        "src/app/*/agents/page.tsx",
        "src/app/*/chat/page.tsx",
        "src/app/*/dashboard/page.tsx",
        "src/app/*/products/**/*.tsx",
        // Project sub-pages that are complex Next.js client components without
        // dedicated test coverage. connections/page is intentionally omitted
        // because it is tested as the "connector-picker" component (#121).
        "src/app/*/projects/page.tsx",
        "src/app/*/projects/*/analysis/page.tsx",
        // Epic #475 (#486) — Discussions tab pages are thin Next.js wrappers; the
        // testable logic lives in src/components/chat/discussion-* (measured).
        "src/app/*/projects/*/discussions/page.tsx",
        "src/app/*/projects/*/discussions/*/page.tsx",
        // Epic #609 (#620) — baseline pages are thin data-wiring wrappers; the
        // testable logic lives in src/components/baselines/* (measured). The
        // list page's summarizeBaseline helper is unit-tested but rides the
        // page exclusion.
        "src/app/*/projects/*/baselines/**/*.tsx",
        "src/app/*/projects/*/changes/page.tsx",
        "src/app/*/projects/*/import/page.tsx",
        "src/app/*/projects/*/jira/page.tsx",
        "src/app/*/projects/*/overview/page.tsx",
        "src/app/*/projects/*/page.tsx",
        "src/app/*/projects/*/plugins/page.tsx",
        "src/app/*/projects/*/publish/page.tsx",
        "src/app/*/projects/*/repositories/**/*.tsx",
        "src/app/*/projects/*/rule-sets/page.tsx",
        "src/app/*/projects/*/scans/**/*.tsx",
        "src/app/*/projects/*/settings/**/*.tsx",
        "src/app/*/projects/*/spec-kit/page.tsx",
        "src/app/*/projects/*/sync/**/*.tsx",
        "src/app/*/projects/*/test-coverage/**/*.tsx",
        "src/app/*/projects/*/usage/page.tsx",
        "src/app/*/projects/*/pulls/**/*.tsx",
        "src/app/*/projects/*/documentation/page.tsx",
        "src/app/*/projects/*/repositories/**/*.tsx",
        "src/app/*/scheduler/page.tsx",
        // skills/page.tsx is a one-line redirect — admin/skills/page is tested.
        "src/app/*/skills/page.tsx",
        // Eval/runs detail pages: thin data-display wrappers not targeted by
        // issue #121. The list pages are tested; detail-view variants follow
        // the same pattern without adding coverage value.
        "src/app/*/eval/leaderboard/*/page.tsx",
        "src/app/*/runs/*/review/page.tsx",
        // Epic #47 (#54) — workspace FinOps page is a thin data-wiring wrapper;
        // its interactive pieces are covered by the finops component unit tests.
        "src/app/*/workspaces/*/finops/page.tsx",
        // Epic #610 (#626) — workspace traceability page is a thin data-wiring
        // wrapper; the rollup logic lives in
        // components/traceability/workspace-traceability-rollup (measured).
        "src/app/*/workspaces/*/traceability/page.tsx",
        // Epic #260 (#84) — the agent authoring wizard route is a thin wrapper;
        // the wizard itself (AgentAuthoringWizard) is covered by component tests.
        "src/app/*/workspaces/*/agents/new/page.tsx",
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        "src/app/**/not-found.tsx",
        "src/app/api/**",
        "src/app/invites/**",
        "src/middleware.ts",
        "src/components/ui/**",
        // Complex interactive data-visualization components that require
        // library-specific mocks (React Flow + dagre) beyond the scope of
        // legacy-UI coverage work. Excluded pending dedicated visual tests.
        "src/components/schema-graph-explorer.tsx",
        "src/lib/auth-types.ts",
        "src/lib/config.ts",
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
