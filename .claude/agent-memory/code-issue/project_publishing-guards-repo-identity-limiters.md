---
name: publishing-guards-repo-identity-limiters
description: Traps in server/src/lib/publishing guards (repo identity is case-insensitive, hand-written prisma mocks sit beside the source) and in adding a guarded route (limiter, walkthrough plan).
metadata:
  type: project
---

Collected from #1207 and #1210 and their reviews (2026-10-16). Checked against `main` at b16dcc30.

**Repo identity is case-insensitive; test every guard with a case-variant target.** GitHub
owner and repo names ignore case, so a repo guard using exact Prisma equality on
`ownerOrOrg`/`repoName` is bypassed by `Openzigs/Metis`. `analysed-repo-guard.ts` lower-cases;
`findCrossProjectOwners` (`cross-project-guard.ts`) did not until #1210, which now compares
`LOWER()` on both sides in a tagged `$queryRaw` (see
[[prisma-cross-database]] for why not `mode: "insensitive"`).

**A new Prisma query in a publishing service breaks mocks next to the source too.** Six
`server/src/lib/publishing/*.test.ts` files hand-write a `prisma.js` mock
(`analysis-finding-publish`, `impact-analysis-publish`, `finding-publish-ports`,
`draft-code-links`, `draft-acceptance-criteria`, `draft-confidence-note`), besides the five
`server/tests` files in [[createbatch-repoconnection-query-breaks-five-mocks]] (folded here;
retired from the index 2026-10-16, file unchanged: three of those five fail only in the full
`pnpm test`, #1171). Grep `server/src` as well; on #1210 only the full `pnpm test` caught it.

**A new route touches two more gates.**
- The `changelog` CI job also runs `scripts/verify-walkthrough-plan.mjs`
  (`pnpm walkthrough:verify-pr`): a PR adding a route or page must edit
  `docs/walkthroughs/TEST_PLAN.md` or carry the `no-walkthrough-impact` label.
- Rate limiters: the rule (copy `runs-rate-limit.ts`, never key on `req.ip`, copy its
  expired-token test) is now in the code-issue skill's Step 4. Background and older tips
  (test determinism with `trust proxy`, refactors that re-surface CodeQL alerts, a second-IP
  fallback test) stay in [[codeql-rate-limit-must-precede-requireauth]] and
  [[new-route-needs-its-own-limiter-keyed-on-user]].
- Jira publishes save issue records with `destination: "jira"` and `issueNumber: 0`. When a batch publishes to both, the Jira record is written after the GitHub one. Any UI that shows published issues must branch on `destination` (#1275).

## PR-URL parsers and repo identity (#1287 c2)

Parsers like `repositoryOfPrUrl` that use `indexOf('pull')` mis-parse an owner or repo named `pull`. Repo identity by owner/name also breaks silently on a GitHub rename, because `RepoConnection.ownerOrOrg`/`repoName` change only when a user edits them.
