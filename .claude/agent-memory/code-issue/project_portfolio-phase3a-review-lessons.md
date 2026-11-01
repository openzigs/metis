---
name: portfolio-phase3a-review-lessons
description: Durable findings from the #1622/#1625/#1647/#1603 reviews and the 2026-11-01 CI break - regex shapes the linear-time suite misses, zod refine after max, engine limits that shrink input, mocked access filters, raw-SQL timestamps.
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
