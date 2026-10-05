# Wave E — Phases 15–20 + developer-issue impact (run {{RUN_NUMBER}})

You are wave E of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[#706](https://github.com/openzigs/metis/issues/706) for Phases 15–20 (PR review, impact,
"Tested by" in traceability, usage and cost, settings, admin) and the "Developer: real open Miniflux
issues" table (#4478, #4511, #4336) with what each must surface.

## State you start from

| Key | Value |
|---|---|
| UI / API | `{{UI_URL}}` / `{{API_URL}}` |
| Project / workspace | `{{PROJECT_ID}}` / `{{WORKSPACE_ID}}` |
| Repo connector / graph | `{{REPO_CONNECTOR_ID}}` / `{{CODE_GRAPH_ID}}` at `{{COMMIT_SHA}}` |
| Analysis run | `{{ANALYSIS_RUN_ID}}` (reviewed — read only) |
| Sandbox issues already created | `{{SANDBOX_ISSUES_SO_FAR}}` (counts toward the cap of 2) |
| Removed phases this run | `{{REMOVED_PHASES}}` (for example Phase 17, replaced by "Tested by" in traceability, #812) |
| Ledger snapshot | `{{LEDGER_SINCE}}` |

## Do

1. Phases 15–20 as #706 defines them, skipping `{{REMOVED_PHASES}}`.
2. For each of the three developer issues: chat "where would I implement this?", impact
   analysis, and Spec Kit `/specify` → `/plan`. Score each against #706's "must surface"
   column (run 2: 0/3). A sandbox draft only if the run's cap of 2 is not used up.
   Run 3 scored 3/3 by the brief and 2/3 strictly: #4478 still proposed a `users` column. Open
   the collapsed **Blast radius** group (`[data-testid=blast-radius-toggle]`) before you
   screenshot the "Writes affected data" rows.
3. **Phase 17 is "Tested by"** (#812), not the removed Test Coverage page. The steps are in
   the latest #706 comment that redefines Phase 17. Its ledger delta must be 0.
4. Phase 18: compare the Usage page, the **All projects** view and `GET /api/admin/usage`
   with the ledger queries in the skill. All three should now agree with `token_usages`
   (#854), and the ledger cost with the token-computed cost (#761). A mismatch is a finding.

## Standing rules — never

- Never publish, comment or review on `miniflux/v2` — the developer issues are read-only
  references there. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- Never run Spec Kit `taskstoissues` without the sandbox repo set explicitly.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker; Phase 19's vault check must not
  print it.

## Tips

Log in once (20 logins / 15 min) and drive the API with in-page `fetch`. Fetch exports
instead of clicking download buttons. Wait 20–40 s after a dev-mode navigation before
snapshotting. Phase 20 admin checks with a second user need `browser.newContext()`; mock
users exist only after their first login, and a membership change needs
`/api/auth/refresh`.

**Scratch files go in `{{SCRATCH_DIR}}/wave-e/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-e/`.

## Step manifest — one line per screenshot (#829)

Every screenshot you keep also gets **one JSON line appended** to
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/steps.jsonl` (the run folder, not the wave
folder; waves run in sequence, so appending is safe). The run's tutorial and report slideshows
are built from it. Schema: the `e2e-walkthrough` skill, section 7.

```json
{"id":"e-2-1","wave":"E","phase":"2","chapter":"Connect a repository","title":"Add the repo connector","screenshot":"wave-e/02-connector.png","tutorial":"Open **Connectors**, choose **Add connector**, paste the repository URL and set **Branch or tag** to `v2.3.3`.","result":"Connector created; lastCommitSha c4d54f87. 41 s.","works":"pass","useful":"pass","issues":[714],"tokens":1830,"costCents":0.21,"ts":"2026-10-03T09:12:00Z"}
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

1. **State hand-off**: impact run IDs per developer issue, and the final ledger snapshot.
2. **Per-phase table**:

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Developer-issue impact**: issue | surfaced the must-surface item? | evidence. Score N/3.
4. **Fix verification** — for each fix in `{{FIXES_TO_VERIFY}}`: fix | PR | holds / regressed | evidence.
5. **Findings** — one line each: severity, phase, symptom, evidence path. Do not file issues.
6. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
