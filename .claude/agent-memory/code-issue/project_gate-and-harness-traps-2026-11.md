---
name: gate-and-harness-traps-2026-11
description: CI and tooling traps seen 2026-11-12/13 — TEST_PLAN for new routes or pages, lint heap size, eval Commit line, Playwright MCP tab and screenshot paths.
metadata:
  type: project
---

From code-review and orchestration on 2026-11-12/13.

- **New route or page needs `docs/walkthroughs/TEST_PLAN.md`.** The changelog CI wants a TEST_PLAN change whenever a PR adds a route or a page. Add the row in the PR, not after the red check.
- **`pnpm lint` needs `NODE_OPTIONS=--max-old-space-size=12288`.** The default heap runs out on the monorepo; the failure reads as a crash, not a lint error.
- **A committed eval reading's "Commit" line must match the PR head.** Re-run or edit the line after the last push, or review flags a reading that describes another commit.
- **Playwright MCP needs a fresh tab**, and screenshots go under `.playwright-mcp/` (never the repo root, never committed).
