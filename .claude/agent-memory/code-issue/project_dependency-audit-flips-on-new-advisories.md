---
name: dependency-audit-flips-on-new-advisories
description: CI Dependency audit fails every PR when an advisory is published
metadata:
  type: project
---

On 2026-09-30 a next critical and five axios Highs landed within 15 minutes; every open PR's audit went red. PR #555 fixed both; its first push broke dependency-audit-1363-advisories.test.mjs, which pins exact override bounds.

**Why:** An author's 'also fails on main' goes stale as soon as the fix lands.

**How to apply:** Fix on one PR, run the WHOLE scripts suite, respect minimumReleaseAge (newest release older than 7 days), then gh pr update-branch each blocked PR; a job re-run reuses the old merge ref.

**From #1300 and #777 (2026-10-20).**
- Reproduce `Dependency audit` locally: osv-scanner v2.3.8 (verify against the release's `osv-scanner_SHA256SUMS`) plus the python gate extracted from `sast.yml`, run from a scratch dir holding `pnpm-lock.yaml`. It takes seconds and matched CI exactly. On #777 it surfaced a vite High published that same day, red on `main` before any PR showed it.
- `pnpm update -r --depth Infinity <transitive>` (pnpm 10.33) also re-resolves unrelated packages (a duplicate `@babel/runtime` under `@testing-library/dom`). Diff the lockfile and revert the extras.
- `images/mcp-wrappers/*` have no committed `package-lock.json`, so their Dockerfiles fall back to `npm install`, and pnpm's `minimumReleaseAge` and frozen lockfile never apply there. Review transitive resolution there, not just the top-level pin.
- The braces waiver GHSA-vfj7-8cjw-p6xm is gone (#1306): ui dropped the unused `eslint-config-next`, braces' only route into the tree, so `WAIVERS = {}` again. Re-adding that package re-adds braces.

**From #1307 and #1308 (2026-10-21).**
- A vite floor must move in **both** the root `package.json` and the `pnpm-workspace.yaml` overrides; `pnpm up` alone leaves a lockfile that fails `--frozen-lockfile`.
- `pnpm install` after a targeted override bump can move unrelated `transitivePeerDependencies` annotations between lockfile snapshots. Reverting them by hand is safe; confirm with `pnpm install --frozen-lockfile`.

**From #1306 (2026-10-21).**
- Dropping `eslint-config-next` also took `browserslist` (via `@babel/core`) out of the tree, so `dependency-audit-1345-advisories.test.mjs`'s "at least one copy" arm went red. A guard that demands presence breaks when a dependency leaves; it now checks the lookup still works instead.
- So before pushing a dependency removal, diff the lockfile's REMOVED packages against every `scripts/lib/dependency-audit-*.test.mjs` (PR #1321).

**Folded here (retired from the index 2026-10-21; file unchanged):** [[project_dependabot-tilde-and-stale-audit]] — Dependabot groups rewrite `~0.x` ranges across minors (hold one with a `dependabot.yml` `ignore`), and a green audit run before an advisory's publish time is stale.
