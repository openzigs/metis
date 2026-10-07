# Wave A — setup + Phases 1–4 (run {{RUN_NUMBER}})

You are wave A of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[#706](https://github.com/openzigs/metis/issues/706) for the definition and pass bars of
Phases 1–4 before you start; the `e2e-walkthrough` skill has the setup order.

## State you start from

| Key | Value |
|---|---|
| UI / API | `{{UI_URL}}` / `{{API_URL}}` |
| METIS commit | `{{METIS_SHA}}` |
| Login user | `{{LOGIN_USER}}` |
| Sidecar | running at `http://127.0.0.1:5070`, `SQL_LINEAGE_MODE=sidecar` |
| Miniflux DB | migrated and seeded (`{{MINIFLUX_DB_URL}}`) |
| Removed phases this run | `{{REMOVED_PHASES}}` (for example Phase 4's bug scan, #799) |

## Do

1. Create workspace `{{WORKSPACE_NAME}}`, then project `{{PROJECT_NAME}}` **inside it** (#731).
   Enable lineage and database-aware analysis.
2. **Save the publish target `openzigs/flux-v2`** before adding any connector.
3. Add the repo connector `https://github.com/miniflux/v2`, **Branch or tag = `v2.3.3`**.
   Confirm `lastCommitSha` and the code graph's `commitSha` both start `c4d54f87`.
4. Run Phases 1–4 as #706 defines them, skipping `{{REMOVED_PHASES}}`.

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
snapshotting. Uploads must come from under the repo.

**Scratch files go in `{{SCRATCH_DIR}}/wave-a/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-a/`.

## Step manifest — one line per screenshot (#829)

Every screenshot you keep also gets **one JSON line appended** to
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/steps.jsonl` (the run folder, not the wave
folder; waves run in sequence, so appending is safe). The run's tutorial and report slideshows
are built from it. Schema: the `e2e-walkthrough` skill, section 7.

```json
{"id":"a-2-1","wave":"A","phase":"2","chapter":"Connect a repository","title":"Add the repo connector","screenshot":"wave-a/02-connector.png","tutorial":"Open **Connectors**, choose **Add connector**, paste the repository URL and set **Branch or tag** to `v2.3.3`.","result":"Connector created; lastCommitSha c4d54f87. 41 s.","works":"pass","useful":"pass","issues":[714],"tokens":1830,"costCents":0.21,"ts":"2026-10-03T09:12:00Z"}
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

1. **State hand-off** (the next wave needs every one):
   `PROJECT_ID`, `WORKSPACE_ID`, `REPO_CONNECTOR_ID`, `CODE_GRAPH_ID`, `COMMIT_SHA`,
   and the ledger snapshot timestamp at the end of the wave.
2. **Per-phase table**:

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix in `{{FIXES_TO_VERIFY}}`: fix | PR | holds / regressed | evidence.
4. **Findings** — one line each: severity, phase, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know (an ordering trap, a new
   gotcha). Prefix each with exactly `Durable finding:`.
