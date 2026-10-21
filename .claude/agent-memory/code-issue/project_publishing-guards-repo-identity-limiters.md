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

## Two "same repository" checks (#1294 review)

Two checks read `PublishBatch.targetOwner`/`targetRepo`: `namesRepository` (case-insensitive) and `pr-reviewer/ac-traceability.ts` (exact case; tracked as #1296). On any repo-matching change, grep `targetOwner` and route every match through `namesRepository`.

**From #1298 and its review (2026-10-20).**
- Adding any prisma call to `generateDrafts` breaks hand-written mocks OUTSIDE `tests/publishing-*` too (`clarify-answer-reaches-published-draft.test.ts` lacked `issueDraft.findMany`). Grep `issueDraft: {` in every test that calls `generateDrafts`.
- Repo/host identity guards in the publisher (`apiBaseKey` vs `targetBaseUrl`) ship untested because every fixture uses public GitHub with a null base URL. Delete each guard as a mutation, and require a GHES-vs-github.com fixture.
- No code path sets `IssueDraft.status` to `'publishing'` (only read filters do), so a guard relying on "not publishing" to exclude an in-flight batch is a no-op.

**From #1308 and its reviews (2026-10-21).**
- `PublishedIssue` holds one row per (batch, draft, destination), so one remote issue can have several rows. Any `findFirst` by `issueId` or `draftId` that reads `row.batch.*` (e.g. `reconcile-service`) must order by `publishedAt desc, id desc`, and the dedup-skip path must make the newest row's claim true.
- The Jira publish leg has no dedup (`dedupHash` null, its rows never consulted), so a "prevents a duplicate on retry" claim about Jira is false.

**From #1106 (2026-10-21).**
- Remote-issue recovery is keyed on `PublishedIssue` rows (`loadRecoverableIssues` in `publisher.ts`), never on tracker text; the marker only vetoes. Keep any new matching DB-only so the dry run and `previewBatchPlan` call the same function and agree (`mayMatchIssueNumber`).
- `publishing-publisher.test.ts`'s fake octokit now pages listings and serves `GET /issues/{n}` (404 when unknown). A test overriding the old list URL no longer reaches recovery: intercept `/issues/{n}$`.
