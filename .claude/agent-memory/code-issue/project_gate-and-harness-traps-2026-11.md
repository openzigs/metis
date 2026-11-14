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
- **Playwright MCP input can go dead after `browser_navigate`** (walkthrough 2026-11-13): trusted clicks and keys stop reaching the page. `browser_close` and re-navigate restores it; `dispatchEvent('click')` or `form.requestSubmit()` works around it. The Next dev overlay also pops on the #2116 duplicate-key errors on the analysis page: press Escape before role queries.
- **`browser_take_screenshot` writes only under the repo** (`.playwright-mcp/`, gitignored). Move shots to the scratchpad afterwards.
- **In an isolated worktree, a Bash call mixing git with `&&`, a heredoc or `$(...)` is refused as too complex to verify.** Put edits in a script file and run each git command in its own plain call.
- **Bash is `/bin/bash` 3.2**: `declare -A` fails (exit 126) in Monitor scripts. Use plain variables.
- **Hand-editing a committed eval reading trips `review:adversarial-required`** (readings carry `projectId`). Expect a panel for eval-data edits.
