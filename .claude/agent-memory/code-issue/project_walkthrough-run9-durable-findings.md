---
name: walkthrough-run9-durable-findings
description: Durable findings from #706 walkthrough run 9 (waves B-G, BA) that TEST_PLAN.md and the e2e-walkthrough skill do not already record (#1172).
metadata:
  type: project
---

From run 9's waves (https://github.com/openzigs/metis/issues/1172#issuecomment-6209010028).
Findings the #1172 TEST_PLAN / runbook edits already record are left out (S21 publishing,
S24 marker, Phase 15 sandbox, fork `upstream` remote, operator-grepped logs, `CGO_ENABLED=0`,
Miniflux's DB-less test skips, operator-created memberships, REPO_CROSS_PROJECT before wave F).

**Product facts a code change must respect**
- `Project.autoReviewPrs` has no UI/API setter (`server/prisma/schema.prisma:433`); webhook PR review is unreachable until one exists (#1169).
- REPO_CROSS_PROJECT (`server/src/lib/publishing/publishing-service.ts:206`) blocks only the Publish batch, dry run included; Spec Kit task export is not blocked (#1171).
- Docs-gen per-document cost needs documents run one at a time: the ledger `sessionId` carries no document id.
- Docs-gen topic-plan / fit log lines go to the dev server's stdout only.
- Architecture "Schema check" note renders only when something is flagged; absence means clean (`schema-claim-check.ts` ~1741).
- `/api/admin/usage` = `token_usages` + project-less chat, by design (#854).
- Second BRD regenerate falls back to the tail cut, squeezing reused sections ~46.5k -> ~37k chars.
- First refresh on an unchanged commit raises lineage reads 740 -> 785 (runs 7-9); report on #1066.

**API / UI shapes (for tests and probes)**
- Spec Kit palette Run button: `data-testid=spec-kit-run-button` (role "Run" is ambiguous).
- `GET /spec-kit/jobs/:id`: status is at `data.job.status`.
- Feature artifacts: `/spec-kit/features/:slug/artifacts/<key>`; project files: `/spec-kit/files/<name>`.
- Chat response: `.data.response.{content,finishReason,usage}`, `.data.grounding.{status,toolReads,sources}`, `.data.toolApprovals`.
- `/chat` defaults to the last-used project scope: set scope, then New chat.
- Run-now refresh on an unchanged commit finishes in ~4 s; cancel with `POST /api/tasks/:id/cancel` immediately, Retry from the Cancelled tab.

**Harness / tooling**
- Playwright MCP: use CSS/role selectors; refs from a targeted `browser_snapshot` do not resolve later. `browser_evaluate` `filename` writes only under the repo or `.playwright-mcp`.
- A second context via `browser.newContext` + in-page fetch login as `developer` was allowed in wave E.
- Miniflux live schema: `docker exec mf-pg psql -U postgres -d miniflux` (no host psql).
- macOS `wc -l` pads with spaces; slice with `awk 'NR>L'`, not `tail -n +$L`.
- Reusable scorers: wave-e/scripts `score_impact.py`, `score_text.py`.

**Budgets**
- S9 handoff: ~21 min first pass + ~18 min / $0.32 per Continue; budget ~45 min / $0.70.
- S16 200-with-featureSlug is a real ~137 s plan: run it on a throwaway feature.
- BA re-ask on deepseek-flash: ~$0.11 and ~4 min for 8 questions.

**Miniflux ground truth**
- BA Q8 periphery: score against the 14 live tables (webauthn_credentials :858, web_sessions :1449, entry_tombstones :1472; user_sessions dropped :1446-1447).
- v2.3.3 has 29 integration packages; `SendEntry` covers 21.
- #4478 UI mark-all-as-read calls `MarkGloballyVisibleFeedsAsRead`; run 9's plan missed it and 4 callers.
- UI template tasks also touch `template/engine.go`, 23 locale catalogs and `app.js`.

**Why:** each cost a wave time to rediscover in run 9.

**How to apply:** read before changing Spec Kit, docs-gen, publishing or usage code that a walkthrough exercises, or before writing a walkthrough probe.
