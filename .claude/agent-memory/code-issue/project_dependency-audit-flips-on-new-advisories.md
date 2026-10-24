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

**Folded here (retired from the index 2026-10-24; file unchanged):** [[split-advisory-fixes-deadlock-audit]] — two HIGHs fixed on separate PRs keep each PR red on the other's advisory; list every advisory locally and fix them all on one branch (#427/#431).

**Folded here (retired from the index 2026-10-21; file unchanged):** [[project_dependabot-tilde-and-stale-audit]] — Dependabot groups rewrite `~0.x` ranges across minors (hold one with a `dependabot.yml` `ignore`), and a green audit run before an advisory's publish time is stale.

**From #1421 (2026-10-22).**
- The OSV `Dependency audit` can go red twice in one afternoon: dompurify GHSA-mrv2-3pqr-j5jr
  landed about 30 minutes after the next.js advisories. Re-run
  `osv-scanner --lockfile=pnpm-lock.yaml` just before pushing a security bump.
- `minimumReleaseAge` (7 days, `pnpm-workspace.yaml`) decides which patch is usable. Check
  `npm view <pkg> time` first: next 16.4.2 was blocked, 16.4.1 allowed.
- `pnpm-lock.yaml` diffs as binary here; use `git diff --text`. A `pnpm --filter ./ui build`
  also rewrites `ui/next-env.d.ts`; revert it ([[next-env-churn]]).

**From #1448 to #1465 (2026-10-23).**
- The audit went red on every PR three times in one evening: zod (#1453, GHSA-mrhx-c7xc-m3w5,
  between 18:23 and 18:42 UTC, two runs of the same lockfile), body-parser (#1458,
  GHSA-27r3-jxmh-p828, ~20:53Z) and undici/msal-node/multer (#1464). For a PR with no
  dependency change, read the audit log's FAIL list, compare with an earlier run of the same
  head, check the SAST run list across branches, and look for a tracking issue before
  debugging the diff.
- When the fixed version is younger than the 7-day `minimumReleaseAge`, mitigate and add a
  narrow waiver with a short expiry rather than bypass the gate (#1458).
- `sast.yml` waivers accept `"packages": ["name@version"]`. Use it when one advisory hits both
  a fixable and an unfixable copy; an ID-only waiver mutes both (#1455).
- Verify a waiver's reachability argument against the advisory's exact mechanism and the
  library's own code in `node_modules/.pnpm/<pkg>@<ver>`. That disproved "chromium-bidi is
  dev-only": it is runtime via puppeteer, loaded only on the BiDi path (#1455 review).
- botbuilder 4.23.3 needs zod ^3.23.8 and calls `.nonstrict()` at load time (removed in zod
  4), so it cannot be overridden to zod 4; its zod 3 copy carries a dated waiver (expires
  2027-01-23). Server `tsconfig.test.json` (CI `api` Typecheck) types `import("zod")` as zod
  4; type a zod 3 runtime copy with `typeof import("zod/v3")`. Local `pnpm typecheck` missed
  the resulting TS2554 (#1455).
- The msal-node GHSA-xcx6 waiver holds only while `@azure/identity-vscode` and `-broker` stay
  out of the tree; `server/src/lib/teams/msal-auth-code-reachability.test.ts` fails first if
  that changes (#1465).
- Local reproduction, exactly as CI: extract the python3 heredoc from `sast.yml` into a
  script, save `osv-scanner scan source --lockfile=pnpm-lock.yaml --format json` as
  `osv-results.json` beside it, and run it; it prints PASS/FAIL (#1465).
