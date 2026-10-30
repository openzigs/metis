---
name: walkthrough-run10-durable-findings
description: Durable findings from #706 walkthrough run 10 (waves A-G, BA) that TEST_PLAN.md and the e2e-walkthrough skill do not already record, plus code facts an implementer of the run's issues needs.
metadata:
  type: project
---

From run 10's waves (METIS `d8fa0d79`; results on #706). The runbook / TEST_PLAN edits of the
run-10 plan PR already record: `toolsWithheld` over the chat API, `X-METIS-CSRF` on curl
writes, `/projects/:id/overview` (no `/code`), the Documentation page's polling lockout, the
sandbox slots belonging to J1.8, S24 needing a real S21 publish, and `works: "blocked"` for a
skipped step.

**Code facts for the run's issues**
- Requirement writes have two routes with **different** gates (#1566):
  `PUT /api/requirements/:id` needs `project.update` (`routes/requirements.ts`), while
  `PATCH /api/analyses/:id/requirements/:reqId` needs only `analysis.run`
  (`routes/analysis.ts`), which `developer` holds. The analysis page's Edit / Approve /
  Reject call the PUT route (`requirementUpdateApi.update`), so a developer gets a 403 after
  filling the dialog, and could still write through the PATCH route. Fix both, test per role.
- The docs page polls `/docs` and `/docs/:id` ~3/s; the generated-docs limiter is 900 per
  15 min, so one open page locks itself out in ~5 min (#1570).
- SQL-lineage sidecar: `/extract_usage` 500s with `AttributeError: 'str' object has no
  attribute 'sql'` on some Miniflux statements; the server degrades gracefully and lineage
  still reads 740 / 361 (#1577). Read `docker logs metis-sql-lineage`, not the server log.

**Harness / environment**
- Wave A spends 0 tokens. Ingest time varies with machine load (17 min in run 10 vs 8-11):
  judge progress by the `documents` count, not the clock.
- SQLite names: `documents.uploadedAt`, `repo_connections`; `code_graphs` has no status
  column; always `sqlite3 -readonly -cmd '.timeout 15000'`. `token_usages.createdAt` is text
  like `2026-10-30T09:49:39.152+00:00`, so a `...Z` bound compares correctly only to the second.
- The first Playwright tab can drop clicks (a fresh tab fixes it); a second tab can trigger a
  dev reload. Switch a second user's context with `clearCookies`.
- Ticking imports scopes the whole analysis run. Regenerate without review work replaces
  every requirement id (~9 min, $0.12-0.16): never hand off ids from a regenerated run.
- `POST /api/projects` needs a slug; custom agents live at `/library?tab=agents&projectId=`.
- The UI `next-server` can restart itself mid-wave: one `/login?reason=expired` bounce with a
  still-valid session.
- The requirements-scoped BRD is deterministic ($0); its export needs the
  `generated_documents` id. Second-user contexts survive a dispatcher cut-off (a Claude usage
  limit stopped wave F for ~2 h 43 min with nothing lost).
