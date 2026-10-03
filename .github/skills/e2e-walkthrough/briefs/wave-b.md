# Wave B — Phases 5–8 (run {{RUN_NUMBER}})

You are wave B of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[#706](https://github.com/openzigs/metis/issues/706) for the definition and pass bars of
Phases 5–8 (database and lineage, import / Jira / test management, analysis and agents,
requirements and traceability).

## State you start from

| Key | Value |
|---|---|
| UI / API | `{{UI_URL}}` / `{{API_URL}}` |
| Project / workspace | `{{PROJECT_ID}}` / `{{WORKSPACE_ID}}` |
| Repo connector / graph | `{{REPO_CONNECTOR_ID}}` / `{{CODE_GRAPH_ID}}` at `{{COMMIT_SHA}}` |
| Miniflux DB | `{{MINIFLUX_DB_URL}}` (1 user, 1 category, 1 feed, 25 entries) |
| Ledger snapshot | `{{LEDGER_SINCE}}` |

## Do

1. Phase 5: add the database connector for the Miniflux DB, then record the lineage edge
   count by kind and source (run 2: 1,436 reads/writes edges).
2. Phases 6–8 as #706 defines them. Record the analysis run ID you create in Phase 7 — later
   waves need it — and do not touch it afterwards except to read it.

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- Never run Spec Kit `taskstoissues` without the sandbox repo set explicitly.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min) and drive the API with in-page `fetch`. Fetch exports
instead of clicking download buttons. Wait 20–40 s after a dev-mode navigation before
snapshotting. Uploads (Phase 6 import files) must come from under the repo.

**Scratch files go in `{{SCRATCH_DIR}}/wave-b/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-b/`.

## Return

1. **State hand-off**: `DB_CONNECTOR_ID`, `ANALYSIS_RUN_ID`, `REQUIREMENT_SET_ID`, the
   lineage edge counts, and the ledger snapshot timestamp at the end of the wave.
2. **Per-phase table**:

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix in `{{FIXES_TO_VERIFY}}`: fix | PR | holds / regressed | evidence.
4. **Findings** — one line each: severity, phase, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
