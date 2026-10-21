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
- The braces waiver GHSA-vfj7-8cjw-p6xm in `sast.yml` was due to expire 2026-11-01 (#1300). #777 re-verified it (no fix in braces, micromatch, fast-glob or @next/eslint-plugin-next; no ESLint config loads the plugin) and re-dated it to **2027-01-15**. From then `Dependency audit` is red on `main` and every PR unless it is re-verified again.

**From #1307 and #1308 (2026-10-21).**
- A vite floor must move in **both** the root `package.json` and the `pnpm-workspace.yaml` overrides; `pnpm up` alone leaves a lockfile that fails `--frozen-lockfile`.
- `pnpm install` after a targeted override bump can move unrelated `transitivePeerDependencies` annotations between lockfile snapshots. Reverting them by hand is safe; confirm with `pnpm install --frozen-lockfile`.
- `ui/package.json`'s `eslint-config-next` is loaded by no ESLint config (Next 16 removed `next lint`), so no Next lint rule runs anywhere. It is also braces' only route into the tree (#1306).
