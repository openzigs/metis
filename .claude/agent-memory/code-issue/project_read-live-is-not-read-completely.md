---
name: read-live-is-not-read-completely
description: A live schema introspection covers one schema and can return [] without error, so a check that removes or rewrites content on its strength must prove the read covered the name it judges. Also where a run's generated documents live, and what the code graph's table/column symbols are.
metadata:
  type: project
---

In this project "read live" does not mean "read completely" — the Postgres driver introspects only `public` by default and an introspection can return `[]` without error, so any check that removes or rewrites content on the strength of a live schema must prove the read covered the name it is judging; fixtures with one connector and one schema hide this.

**Why:** PR #1093 (#1061) shipped a `current: true` flag on the schema inventory, "every connector was introspected in this run", and let the claim check remove a column whenever it was set. Review found three ways it was true and wrong. A connector that returned `[]` (what a role without grants gets) counted as read, because `if (live)` is true for an empty array. `drivers/postgres.ts` reads `opts.schema ?? "public"` and `sqlserver.ts` reads `dbo`, so "live" was one schema. And `resolveTable` dropped a schema prefix, so `### Entity: audit.users` was judged against `public.users` and its real `actor_ip` column was removed. Every test passed: every fixture had one connector and one schema, the one case where "live" and "complete" are the same thing.

**How to apply:**

- Make completeness a property of what was read, not of the whole result. The inventory now records per connector `how` (`live` / `stored` / `unread`) and the schemas that returned tables, each table points at its read, and zero tables is `unread`. See `mayRewriteAgainst` in `server/src/lib/docs-gen/schema-inventory.ts`.
- Three outcomes, not two: remove or rewrite only with proof; mark when it cannot be proven; **say nothing** when it cannot be judged at all (a name qualified with a schema nothing read).
- Never drop a qualifier to make a name resolve. An unqualified name that resolves to two tables (two schemas, two connectors) is ambiguous: mark at most.
- Fixtures for any check over an introspected schema need, at minimum: an empty result beside a non-empty one; two schemas with a same-named table; a qualified name in an unread schema; a second connector that is stored-only or unread.
- `inspectDbConnector` takes no `AbortSignal`: an introspection you stop waiting for runs to the driver's own timeout and still writes its audit row. Bound concurrency; do not claim it was cancelled.
- The prompt has to say what the list covers. "Never name a table that is not in the schema" is false for every schema that was not read.

## Where a run's artifacts are, and what the code graph's schema symbols are

A run's generated documents live in `server/dev.db` table `generated_documents` (`content`; `schemaGraph` on the `scope='database'` row), not as files under `.playwright-mcp/`; and the code graph's `table`/`column` symbols are a names-only historical superset (dropped tables, indexes parsed as tables), never the current schema.

- To measure a check against a past run, copy `server/dev.db` and read only the copy (`sqlite3 -readonly`), selecting by `projectId` and `scope`. The walkthrough's architecture document for the Miniflux project is the `scope='repository'` row; its ground truth is the `schemaGraph` JSON on the `scope='database'` row (14 tables, 266 columns in run 7).
- `code_symbols` rows with `kind in ('table','column')` gave 17 tables for the same project: use them to mark, never to remove, and never as an answer key.

Links: [[deterministic-gate-over-llm-output-probes]], [[impact-offline-replay-and-pinned-shapes]].
