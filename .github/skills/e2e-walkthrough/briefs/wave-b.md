# Wave B — Phases 5–8 (run {{RUN_NUMBER}})

You are wave B of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md) for the definition and pass bars of
Phases 5–8 (database and lineage, import / Jira, analysis and agents,
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
2. Phases 6–8 as the plan defines them. Record the analysis run ID you create in Phase 7 — later
   waves need it — and do not touch it afterwards except to read it.
3. The added steps below, each with its expected outcome. Drive them in the UI; the only
   `fetch` calls are the ledger and SQL reads.

## Added steps (run 4)

**Phase 5 — move an existing project into a workspace (#731, PR #927).** Create a throwaway
project `Workspace move check (run {{RUN_NUMBER}})` with no workspace. Open its **Project
settings → Workspace** card, choose `{{WORKSPACE_NAME}}`, **Add**, and confirm.
- Expected: the card shows the workspace (`workspace-assign-current`), the project is listed in
  the workspace, and the "not part of a workspace" notices link to the card rather than dead-end.
- Expected: on `{{PROJECT_NAME}}`, which is already in a workspace, the card offers no move.
- In Phase 8, the moved project appears in `/workspaces/{{WORKSPACE_ID}}/traceability`. Call
  `/api/auth/refresh` first if the workspace claim looks stale.

**Phase 7 — custom and library agents are labelled honestly (#727, PR #924).**
- In `/workspaces/{{WORKSPACE_ID}}/agents/new`, the **tools** step lists `search_code_graph`,
  `search_code_symbols` and `read_file_slice`. The **playground** says it runs on the prompt
  alone, and every playground answer carries the "Ungrounded answer" notice.
- Enable the library agent and "Go SQL reviewer", then start a **second** analysis run and let it
  finish. Their findings carry the **Not checked against code** badge (`ungrounded`), and the
  findings filter offers **Not checked**. A custom-agent finding shown as Confirmed or Could not
  verify is a FAIL. Record its ID as the agent run, and cancel a third run for the plan's Cancel check.
- On the agent run, **reject** one approval item: the run continues without it and the item has
  **Reopen** (#723, PR #902). This is the re-verification the reject guard-rail waits on; never
  do it on `ANALYSIS_RUN_ID`.

**Phase 7 — web research without a provider (#864, PR #922).** Confirm `WEB_SEARCH_PROVIDER` is
unset.
- Expected: **Evidence Review** shows one notice (`web-research-notice`) saying no web search
  provider is configured, and no "No web sources found" digest per evidence need.
- Expected: the `web` agent cites no repository file (`*.go`, `internal/…`), no database
  object and no score-0 fallback chunk. Count its citations by kind; any of these is a finding.

**Phases 7–8 — approved requirements keep their criteria and code links (#730, #909; PRs #894,
#926).** Approve the requirements in the Approvals checkpoint (edit one first).
- Expected: the Requirements page shows the reviewed titles, each with its acceptance criteria and
  code links. The Approvals tab warns if the reviewed list differs from the synthesis set, and
  Deep Dive reads "Checking approvals…" while loading, never "0 pending".
- **Measure** how many promoted requirements have no acceptance criteria and no code link. Report
  both counts over the total; a rise from run 3 is a regression:
  ```sql
  SELECT COUNT(*) AS promoted,
         SUM(CASE WHEN r."acceptanceCriteria" = '[]' THEN 1 ELSE 0 END) AS zero_ac,
         SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM requirement_code_mappings m
                                   WHERE m."requirementId" = r.id) THEN 1 ELSE 0 END) AS no_code_link
  FROM requirements r
  WHERE r."analysisId" = :analysis AND r."deletedAt" IS NULL;
  ```
- An edit sent with a stale `version` gets **409 `VERSION_CONFLICT`** (#871, PR #877).

**Phase 8 — start a review and pin a baseline from the UI (#732, PR #929).** Log `coordinator`
in once in a second context so the user exists.
- On the Requirements page, **Request review**, choose `coordinator`, and send.
  Expected: `request-review-done` confirms it, and the review is listed on `/reviews`.
- On `/projects/{{PROJECT_ID}}/baselines`, as `admin`, **New baseline**. Expected: a row pinning
  the current version of every requirement. Make a second one after an edit and **compare**
  them; the compare shows the edit. Use `POST …/baselines {name, requirementIds}` only for a
  subset, which the UI does not offer.

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- Never run Spec Kit `taskstoissues` without the sandbox repo set explicitly.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min). Drive the UI, and keep in-page `fetch` for checks with no
UI (the ledger, `/api/auth/refresh`, a stale-`version` write). Fetch exports
instead of clicking download buttons. Wait 20–40 s after a dev-mode navigation before
snapshotting. Uploads (Phase 6 import files) must come from under the repo.

**Scratch files go in `{{SCRATCH_DIR}}/wave-b/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-b/`.

## Step manifest — one line per screenshot (#829)

Every screenshot you keep also gets **one JSON line appended** to
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/steps.jsonl` (the run folder, not the wave
folder; waves run in sequence, so appending is safe). The run's tutorial and report slideshows
are built from it. Schema: the `e2e-walkthrough` skill, section 7.

```json
{"id":"b-2-1","wave":"B","phase":"2","chapter":"Connect a repository","title":"Add the repo connector","screenshot":"wave-b/02-connector.png","tutorial":"Open **Connectors**, choose **Add connector**, paste the repository URL and set **Branch or tag** to `v2.3.3`.","result":"Connector created; lastCommitSha c4d54f87. 41 s.","works":"pass","useful":"pass","issues":[714],"tokens":1830,"costCents":0.21,"ts":"2026-10-03T09:12:00Z"}
```

`screenshot` is relative to the run folder: no `..`, no absolute path. `works` is `pass`, `partial`, `fail` or `blocked`; `useful` is `pass`, `weak`, `fail` or `n/a`
(same scales as the results template). A step with `works` of `fail` or `blocked`, or `useful` of
`fail`, is left out of the tutorial, so still record it. `tutorial` speaks **to a user, about the task**; `result` speaks to the
reviewer, about what happened. Reuse a chapter name exactly as an earlier step spelled it (copied or
near-duplicate names split a chapter); the example above is a format sample, not a step to record.
Omit `tokens` and `costCents` when you cannot read them from the ledger.

| Good `tutorial` | Bad `tutorial` |
|---|---|
| Open **Connectors** and choose **Add connector**. | The agent clicked the Add connector button. |
| Ask a question in plain words, for example `Where are feeds refreshed?`, and open a citation to check it. | Sent message 3 via the API; got 200 in 14 s. |
| Wait until the index status reads **Ready**; large repositories take a few minutes. | Indexing was slow (⚠️, see #717). |

Only `**bold**`, `` `code` `` and `[links](https://…)` are formatted; everything else is shown
as plain text.

## Return

1. **State hand-off**: `DB_CONNECTOR_ID`, `ANALYSIS_RUN_ID`, `REQUIREMENT_SET_ID`, the agent
   run ID, the moved project's ID, the review and baseline IDs, the lineage edge counts, the
   zero-criteria and no-code-link counts, and the ledger snapshot timestamp at the end of the wave.
2. **Per-phase table**:

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix under "Fixes to verify this wave": fix | PR | confirmed / partial / regressed / not-exercised | step id.
4. **Findings** — one line each: severity, phase, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
