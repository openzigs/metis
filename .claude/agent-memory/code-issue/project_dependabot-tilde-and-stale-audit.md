---
name: project_dependabot-tilde-and-stale-audit
description: Dependabot group PRs rewrite ~0.x ranges across minors; a green Dependency audit predating an advisory is stale
metadata:
  type: project
---

Dependabot's grouped minor/patch PRs rewrite `~` ranges across a 0.x minor, so a tilde pin does not hold a breaking bump back (PR #907: ui `katex` `~0.16` → `~0.18`, caught by the #310 parity test `ui/tests/katex-stylesheet-parity.test.ts`). Holding a 0.x package needs a `dependabot.yml` `ignore` entry. Separately, an advisory published after a PR's CI run makes its green `Dependency audit` stale (GHSA-cjq9, next 16.3.6, 2026-10-07).

**Why:** both made a Dependabot PR look safer than it was.

**How to apply:** compare advisory publish time with the run time before trusting a green audit; add `ignore` entries for 0.x packages that must stay on a minor.
