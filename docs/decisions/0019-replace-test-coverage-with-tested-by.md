# 0019 — Replace the test-coverage subsystem with "Tested by"

- **Status**: Accepted
- **Date**: 2026-10-03
- **Issue**: [#812](https://github.com/openzigs/metis/issues/812) (epic), recorded by
  [#820](https://github.com/openzigs/metis/issues/820)
- **Companion**: [ADR 0018](0018-remove-the-ai-bug-scanner.md) (the bug-scanner removal,
  epic [#799](https://github.com/openzigs/metis/issues/799), which follows the same
  add, remove, drop shape)

## Context

METIS shipped a project-level test-coverage gap analysis (Epic #856). It imported test
cases from spreadsheets, documents and Gherkin, or pulled them from Jira, Xray, Zephyr
Scale and TestRail through test-management connections. It embedded those test cases
into their own vector namespaces (`tc:{projectId}`, `tcs:{projectId}`), asked an LLM
judge to match each requirement to test cases, suggested tests for the gaps, and
exported the result to Excel, Gherkin, Playwright page objects or the external tools.
It had its own run lifecycle, socket events, rate limiter, cost tracker and budget knob
(`TESTCOVERAGE_BUDGET_CENTS`), and a **Test Coverage** page under a project's **Code**
tab.

It was about 8.7k lines of server code: `server/src/lib/testcoverage/` (6,354 lines in
37 files), `routes/test-coverage.ts` (1,233) and `lib/connectors/testmgmt/` (1,063),
plus its UI and e2e specs.

## Decision

Replace it with **"Tested by"** inside the traceability spine, then remove it:

1. **Add** (#813–#816): a table-driven test-symbol classifier, a resolver that derives
   the tests covering a requirement from its requirement-to-code mappings plus test
   naming conventions and code-graph edges, the API fields and roll-up figures, and the
   UI (the **Tested by** section on a requirement card, the **Untested requirements**
   list and the workspace **Tested** column).
2. **Remove** the UI and e2e specs (#818), the server code, routes, connectors, rate
   limiter and shared contracts (#819), and the documentation (#820, this record).
   METIS is pre-1.0 (`0.x`), so the UI and API get no deprecation period and no
   redirect from the old route.
3. **Drop** the tables one release later (#821).

## Rationale

- **Requirement-to-test gaps belong to the traceability core, not to a second
  pipeline.** The subsystem duplicated the code graph: it had its own imports, its own
  vector namespaces, an LLM judge, a cost tracker and three external connectors. Tests
  that exist in the repository are already `CodeSymbol` rows, because code-graph
  ingest does not skip test files. A test in the repository is a better witness than a
  model's opinion of a spreadsheet row.
- **It scored 0% in walkthrough [#706](https://github.com/openzigs/metis/issues/706).**
  Phase 17 spent about 96k tokens and produced no coverage, because the judge's
  verdicts were never persisted
  ([#794](https://github.com/openzigs/metis/issues/794), closed as not planned under
  #812; its PR #808 was closed unmerged).
- **Its quality was bounded by fallback requirements.** It judged tests against
  whatever synthesis produced, which was often keyword-grouped fallback requirements
  with no acceptance criteria
  ([#730](https://github.com/openzigs/metis/issues/730),
  [#751](https://github.com/openzigs/metis/issues/751)).
- **Maintenance load.** It needed a BOLA fix (#795), a dedicated rate limiter, three
  `TEST_COVERAGE_*` env knobs, its own budget knob and vault-rotation support for its
  connectors (#609). Its judge spend bypassed the project ledger (#792).
- **The replacement is cheaper and more honest.** "Tested by" makes no model call. It
  labels each link by how it was found (mapped directly, calls the code, naming
  convention), reports a strict figure beside the total, and tells "no test" apart from
  "no code mapped", so a requirement METIS cannot judge is never counted as untested.

## Data plan

The tables are **kept for one release**, then dropped in
[#821](https://github.com/openzigs/metis/issues/821), behind the same gate as #806: a
tagged `0.x.y` release that contains #818 and #819.

- The seven models stay in both Prisma schemas, unused, for one release:
  `TestCoverageRun`, `TestCaseImport`, `TestCaseDoc`, `CoverageMapping`, `GapItem`,
  `Suggestion` and `TestManagementConnection`. Operators get one upgrade in which the
  data can still be exported (a logical dump, or `sqlite3` / `pg_dump` of the tables),
  and the removal can be reverted without a data migration.
- The vault keeps counting test-management connections as consumers of a secret
  (foreign-owner rotation and retirement) until #821 drops the table, so no secret one
  of them references looks unused in the meantime.
- Vectors in the `tc:*` / `tcs:*` namespaces are outside SQL; #821 decides whether a
  one-off cleanup removes them or they wait for the next reindex.
- History stays: `ai_token_usages` rows with an `agentStep` of `testcoverage.*`, audit
  entries `test-coverage.*` and `connector.testmgmt.*`, and `issue_drafts` rows whose
  `metadata.source` is `test-coverage-export`.

## Consequences

- The approval gate (`server/src/lib/reviews/approval-gate.ts`) still reads the legacy
  `mappedRequirementIds` draft-metadata key, so drafts exported to GitHub by the removed
  subsystem stay gateable.
- The `testcoverage:run-update` / `testcoverage:run-finished` socket events, the
  `/api/projects/:projectId/test-coverage` and test-management routes, and the
  `TESTCOVERAGE_BUDGET_CENTS` and `TEST_COVERAGE_*` env knobs no longer exist.
- Walkthrough #706 replaces Phase 17 with a "Tested by" check.
- The unreleased changelog fragments that described fixes to the removed feature were
  deleted or trimmed in #820, so the first release's notes do not announce them.
