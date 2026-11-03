---
name: portfolio-phase3a-review-lessons
description: Durable findings from the #1608 phase-3 and phase-4 reviews (#1622-#1630, #1647, #1657, #1668, #1673) and the 2026-11-01 CI break - walk skip guards, redaction of model fields, regex shapes the linear-time suite misses, zod refine after max, engine limits that shrink input, mocked access filters, raw-SQL timestamps.
metadata:
  type: project
---

From the reviews of PRs #1650, #1651, #1653-#1655 and the #1656 CI fix, 2026-11-01. Follow-ups: #1657. Earlier phases: [[portfolio-phase1-review-lessons]], [[portfolio-phase2-review-lessons]].

- **The linear-time suite misses some quadratic regexes (#1647).** `expectLinearTime` only
  catches a quadratic regex if the hostile input builds the right shape, and two new
  regexes slipped past it:
  - adjacent `\s*` and `\s+` around an optional group, which goes quadratic on a long
    whitespace run;
  - a match that can start at every separator (`(?:^|:)`) followed by a greedy run to the
    end.
  Also, zod 4 still runs `.refine` after `.max()` fails, so a regex inside a refine gets
  the whole body (up to 10 MiB), not the declared max. Short-circuit on length first.
- **Engine limits that silently shrink the input (#1622).** The input schema allowed 50
  acceptance criteria, but the engine kept 8 and the roll-up still said `covers`. A false
  "already implemented" is the expensive error. Check that `maxCriteria`, `hitsPerProduct`
  and the cost caps cannot shrink what was asked for before the roll-up runs. Fixtures with
  two criteria never reach the limit.
- **Mocked access filters (#1625).** Unit tests for read-time access filters mock
  `prisma.findMany` to return rows that are already filtered, so removing a `where` clause
  such as `deletedAt: null` passes every test. Mutate the query filter itself, and require
  a migrated-SQLite test for soft-delete and visibility filters.
- **Index-based evidence references (#1603).** Anything that resolves
  `evidenceFindingIndexes` must use the order synthesis numbered the findings in. Grep every
  `readFlattenedFindings` caller: a copied comment ("as promotion reads them") spread the
  database-order defect to a third reader.
- **Raw-SQL timestamps in tests (#1656).** A raw `INSERT` that lets `createdAt` default to
  `CURRENT_TIMESTAMP` stores `YYYY-MM-DD HH:MM:SS`. A Prisma `gte` against
  `YYYY-MM-DDT00:00…` compares as text, and on the 1st of a month the space sorts below the
  `T`. The usage-ledger test broke every PR's `server-unit (1/3)` on 2026-11-01. Write
  `createdAt` as ISO in raw inserts.
- **The image scan needs its own waiver (#1652).** A `sast.yml` waiver does not cover the
  Trivy image scan. A CVE alias of the advisory needs a mirror entry in
  `.github/image-scan-waivers.json`, and the scan runs only on PRs that touch an image path,
  such as `schema.prisma`. A fixed entry moves to `expired`; it is never deleted.
- **Two schemas with the same rule (#1653).** `portfolio-assessments.ts` parses the engine's
  `portfolioGapInputSchema` before the 202, so a route test that expects 400 can't tell
  whether the HTTP schema or the engine's identical rule refused the request. Pin the HTTP
  rule in `@metis/shared`, or use a request whose answers differ on the `requirementId`
  path (400 vs 404).
- **Stacked PRs meet main's semantics late.** When a dependent base PR merges after a
  sibling batch's PR changes the same schema, run the base's tests on the merged result
  before merging: CI on the stacked branch never saw the sibling. Here #1647's one-product
  rule and its import-time `Prisma` read broke #1650 and #1653 only after the merge.

Phase 3b: the reviews of #1665 (#1657), #1666 (#1623) and #1667 (#1624), 2026-11-01. Follow-ups: #1668.

- **Skip guards in graph walks (#1623).** A `continue` that comes before the queue write
  (`next.set`) stops the traversal as well as the listing. #1666 shipped a walk that never
  moved within a downstream product, and deleting the guard left all 48 tests green.
  Mutate every skip in a walk loop yourself; don't rely on the author's mutation list.
  Check direction against `relationship-detector.ts`: `detectSharedTables` emits ONE
  `writes` edge between two writers, from the lower id.
- **Read-time redaction covers every model-written field (#1624).** Paragraphs carry
  `mentions` and are dropped, but restated requirements and `baSummary` sentences carry
  nothing and pass through unfiltered. The generation-time allow-list includes every
  product the run could read, so a passing post-check doesn't prove a field is safe.
  Use fixture models whose output names a product.
- **Error status after a side effect (#1657).** `ClarificationDialog.submitAnswers`
  persists the dialog round (`writeDialogState`) before the route persists requirements.
  So a guard after it, such as the 409 REQUIREMENTS_REPLACED, fires once the round is
  already consumed, and its "answer again" may be impossible. Check where a new status is
  thrown relative to the writes before it. Fixed in #1668: `submitAnswers` takes a
  `beforeCommit` hook that runs before `writeDialogState`.
- **A conditional write inside a batch transaction (#1668).** Interactive transactions
  collide on SQLite under concurrency, so the store uses batch `$transaction([...])`. To
  make a batch conditional, put a Prisma `update` whose `where` names the status as well
  as the id first. When it matches nothing it throws `P2025`, and the whole batch rolls
  back, child rows included. `updateMany` returns a count instead, so it can't abort a
  batch.

Phase 4: the reviews of #1671 (#1668), #1670 (#1626) and #1672 (#1627), 2026-11-01. Follow-ups: #1673.

- **Generation-time wording is recomputed for narrower readers (#1668).** Sentences and
  counts written when the run generates its report (`impactOverview`,
  `stoppedAtRestricted`, `baSummary`) are recomputed or passed through at read time for
  readers with less access. Check every "restricted / not followed / not affected"
  wording against assessment-view's narrower-reader path, not only against the run's
  actor.
- **Check UI polling against the per-user read limiter (#1626).** The portfolio read
  limiter allows 300 requests per 15 min, one every 3 s, which is exactly the page's poll
  interval, so a long run uses the whole budget. TanStack v5's `refetchInterval` keeps
  firing on error, so a function that checks only `data?.status` polls a 404 forever.

Phase 5: the reviews of #1676 (#1673), #1675 (#1628), #1678 (#1629) and #1679 (#1630), 2026-11-01. Follow-ups: #1680.

- **Reader-relative wording, wider readers too (#1673).** "You cannot read" text stored at
  run time comes from the starter's access, but `mayRead` also lets admins and wider
  readers open the run. Check every reader-relative sentence against a reader who sees
  *more* than the starter, as well as one who sees less.
- **Two meanings of "restricted" (#1630).** As a coverage state it means the reader can't
  read the product. As an impact kind (#1673) it marks a product the reader CAN read
  whose path, or whether it is reached at all, runs through something they can't. Docs
  and UI copy must keep the two apart.
- **`GET /products` pages by `pageSize`/`page`** (`paginationQuerySchema`) and silently
  ignores `limit` (#1673). The portfolio picker sent `limit: 100` and got 25.
- **e2e leak checks need a substring match (#1629).** `getByText(name, {exact: true})`
  with a count of 0 only catches an element whose entire text is the name. Use
  `expect(page.getByRole("main")).not.toContainText(name)`. A spec that cleans up data
  must refuse to run under `E2E_SKIP_WEBSERVER` (the developer's own stack).
- **Recording e2e model fixtures without credentials (#1629).** Use `AI_RECORD=1` plus
  `AI_OFFLINE_SCRIPT_FILE`, matching on a prompt substring unique to each call. A local
  run's global setup writes 4 untracked clarify fixtures into `e2e/fixtures/llm`; never
  commit them.

The #1677 and #1680 reviews, 2026-11-01. Follow-ups: #1685.

- **Adjacency labels need a transitive closure (#1680).** The hops #1668 made free (an
  edge inside one product, a resource meeting inside one product) mean a one-hop
  "next to a restricted stop" check can't be the whole reachability answer. Close
  any adjacency rule through those hops, or "never stated unaffected" fails quietly.
- **Removing a purge can remove the only cleanup between retries (#1677).** With
  `retries: 1`, `describe.serial` re-runs `beforeAll`. Fixed fixture names such as
  "Payments" then get seeded twice, and exact rowheader locators hit strict-mode
  violations. Track created ids and delete them in `afterAll` and before a reseed.

The #1685 review, 2026-11-02. Follow-ups: #1689.

- **Test a reader-side relabel against the full-visibility walk (#1685).** The
  restricted relabel (`nextToProducts`) was tested only as the restricted reader (ANA).
  It reached past the walk (every repo of a marked product, no `maxDepth`) and fell short
  of it (paths through unlisted or unreadable products), and every test still passed.
  Pair each relabel assertion with what MIA's walk (same fixture, `maxDepth` 4) reports.

The #1689 review, 2026-11-02.

- **Test depth rules exactly at the limit (#1689).** In the relabel fixture, `maxDepth` 4
  left enough slack that a mutation making a move inside one product cost a step of depth
  stayed green across all 34 tests. Any check of depth needs a case that sits exactly at
  the limit, so that one extra step turns it red.

The #1692 review, 2026-11-02.

- **Severity is not neutral to reach (#1692).** `offer()` keeps the more severe state, and
  that state's `productId` decides which moves inside one product are free. A walk that
  skips evidence (contracts) can therefore reach different products. Before claiming it
  reaches the same ones, test a breaking contract plus a repo in more than one product,
  exactly at `maxDepth`.

The #1643, #1616 and #1617 reviews, 2026-11-02. Follow-ups: #1702, #1703.

- **Edge writes and contract docs: check the order (#1643).** Edges link to the latest
  `ProductContractDoc`, so detecting before `recordContractDocVersion` stores an API edge
  with `contractDocId` null and then links it on the second run. An idempotency test needs
  an API (openapi) pair to catch this; table and event fixtures can't.
- **A capped read must never feed stale-edge deletion (#1643).** A loader that stops at N
  files in sorted order can miss the file that held an edge, and the sync then deletes it,
  an overridden one included. Report the read as `partial` and keep that repo's edges.
- **Check what reads an artifact, not only what writes it (#1616).** Spec Kit's later
  commands embed `spec.md` in a plain md block with no untrusted-data fence. Source text
  written into `spec.md` verbatim skips the fence it had at `/speckit.specify`.
- **TanStack v5 `onSuccess` in `useMutation` options runs after unmount (#1617).** A
  consumer of a synchronous model route that calls `router.push` there navigates after
  the user has left. With no start token, a retry after a lost response duplicates the
  creation.
