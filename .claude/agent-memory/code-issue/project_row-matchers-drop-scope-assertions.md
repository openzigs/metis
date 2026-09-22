# A row matcher stops asserting the columns it does not model

Replacing a mocked-ORM `toHaveBeenCalledWith` with a helper that answers
`aggregate`/`findMany` from a row set is better for the `where` clauses it DOES
model — and silently stops asserting every column it omits.

Measured on PR #82: the refactor at `server/tests/lib/testcoverage/cost-tracker.test.ts`
dropped the `sessionId` scope assertion the old call-shape assertion carried, and
removing `sessionId` from the production aggregate left all 322 tests green
(filed as #94). The embedding arm kept its assertion; only the refactored arm
was exposed.

When replacing a call-shape assertion with a row matcher, diff the columns the
old assertion pinned against the ones the matcher filters on. Scoping keys
(`sessionId`, `projectId`, tenant ids) are the ones that go missing, and they
are the ones whose loss crosses runs.
