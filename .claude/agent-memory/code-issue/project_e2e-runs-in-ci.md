---
name: e2e-runs-in-ci
description: The full e2e suite runs on every PR (ci.yml job `e2e`); PR bodies kept wrongly claiming it is switched off.
metadata:
  type: project
---

The `e2e` job in `.github/workflows/ci.yml` runs the full Playwright suite on pull requests (about 600 specs, roughly 20 minutes). Two removal PRs, #834 (#803) and #841 (#818), wrote "the full e2e job is switched off in CI" in their PR bodies while CI had in fact run and passed it. Reviewers flagged both.

Related: removal PRs prove "the URL now 404s" with a static route-table test (`ui/tests/removed-*-routes.test.ts`). Check catch-all segments (`[...x]`, `[[...x]]`) in every ancestor, and also any single dynamic sibling (`[x]`) beside the removed segment, since either would swallow the URL.

**Why:** a false CI claim makes an acceptance criterion ("e2e green in CI") look unverified, and a route test that misses dynamic siblings can stay green while the URL still resolves.

**How to apply:** before writing CI claims in a PR body, read `gh pr checks <pr>` and the `e2e` job log. In removal route tests, assert both the catch-all and the dynamic-sibling cases.
