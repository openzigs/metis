---
name: read-live-is-not-read-completely
description: A live schema introspection is not a complete table or column list (one schema, [] without error, column privileges, Oracle's 10,000-row cap), so a feature that deletes or corrects content because a name is absent from it needs a per-table completeness proof or must mark instead. Also where a run's generated documents live, and what the code graph's table/column symbols are.
metadata:
  type: project
---

A "read live" introspection in this project is not a complete column list — `drivers/oracle.ts` silently caps introspection at `maxRows: 10_000`, and the PostgreSQL, MySQL and SQL Server `information_schema` queries return only columns the role has a privilege on — so any feature that deletes or "corrects" content because a name is absent from an introspected table needs a per-table completeness proof, or must mark instead. #1093 went mark-only after two review cycles of new deletion routes.

**Why:** PR #1093 (#1061) checked the architecture document's Data Architecture section against the schema and removed what it could not resolve. Each review found new ways for that to delete correct content, and each fix narrowed the gate without closing the class:

- Cycle 1: a `current: true` flag ("every connector was introspected in this run") was true and wrong three ways. A connector that returned `[]` (what a role without grants gets) counted as read, because `if (live)` is true for an empty array. `drivers/postgres.ts` reads `opts.schema ?? "public"` and `sqlserver.ts` reads `dbo`, so "live" was one schema. And a schema prefix was dropped to make a name resolve, so `### Entity: audit.users` was judged against `public.users`.
- Cycle 2, after removal was gated on "one table, read live, no database unread": the gate proved WHICH table, never that its column list was complete. Oracle's cap leaves the last table with a prefix of its columns (follow-up #1096). Column-level grants hide real columns. A Mermaid attribute written `name type` was read as `type name` and every real column removed. A schema written outside the code span (`audit.` before it, `(audit schema)` after it, a diagram alias) was dropped. Index and constraint rows, prose sharing a cell with a removed name, and a Go expression in a Description cell were deleted or rewritten.

Every test passed each time: the fixtures had one connector, one schema, one attribute order and a complete column list, the one case where the parse and the read are both right.

**How to apply:**

- Before building anything that deletes or rewrites on "absent from the introspected schema", ask what proves the read complete FOR THAT TABLE. Here nothing does. Without it: mark, and say in a note what was not checked. A wrong judgment must cost a mark, not content.
- A mark-only check should have its mark-only property tested: output with markers and the note removed equals the input, over generated documents (`schema-claim-check.test.ts`). It caught nothing new, and it makes the next "small correction" impossible to add silently.
- A finding from a heuristic that can be wrong is information, not a degradation: `severity: "info"`, excluded by `affectsDocStatus`, never a reason to block or force section reuse. A "rewrite until clean" rule on such a finding is unbounded.
- Never drop a qualifier to make a name resolve, and read the qualifier from the whole heading or label, not only the code span.
- Three outcomes, not two: mark what was looked for and not found; **list as not checked** what the read cannot speak for (unread schema or database, possibly truncated read); say nothing only about what is not a claim. Silently unjudged names read as approved.
- Fixtures for any check over an introspected schema need, at minimum: an empty result beside a non-empty one; two schemas with a same-named table; a qualified name in an unread schema; a second connector that is stored-only or unread; both attribute orders; an index row; a name with prose in its cell.
- `inspectDbConnector` takes no `AbortSignal`: an introspection you stop waiting for runs to the driver's own timeout and still writes its audit row. A worker that gives up on one must start no other, or the bound on abandoned reads is twice the concurrency.
- The prompt has to say what the list covers. "Never name a table that is not in the schema" is false for every schema that was not read.

## Where a run's artifacts are, and what the code graph's schema symbols are

A run's generated documents live in `server/dev.db` table `generated_documents` (`content`; `schemaGraph` on the `scope='database'` row), not as files under `.playwright-mcp/`; and the code graph's `table`/`column` symbols are a names-only historical superset (dropped tables, indexes parsed as tables), never the current schema.

- To measure a check against a past run, clone `server/dev.db` (`cp -c` on APFS) and read only the clone (`sqlite3 -readonly`), selecting by `projectId` and `scope`. The walkthrough's architecture document for the Miniflux project is the `scope='repository'` row; its ground truth is the `schemaGraph` JSON on the `scope='database'` row (14 tables, 266 columns in run 7).
- `code_symbols` rows with `kind in ('table','column')` gave 17 tables for the same project: use them to mark, never as an answer key.

Links: [[deterministic-gate-over-llm-output-probes]], [[impact-offline-replay-and-pinned-shapes]].
