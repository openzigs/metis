# Wave D — Spec Kit S1–S24 (run {{RUN_NUMBER}})

You are wave D of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read the
"Spec Kit (Phase 14, in full)" section of
[`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md) for steps S1–S24, how to drive each one and its pass bars.
S24 is optional (it needs a public webhook).

## State you start from

| Key | Value |
|---|---|
| UI / API | `{{UI_URL}}` / `{{API_URL}}` |
| Project / workspace | `{{PROJECT_ID}}` / `{{WORKSPACE_ID}}` |
| Repo connector / graph | `{{REPO_CONNECTOR_ID}}` / `{{CODE_GRAPH_ID}}` at `{{COMMIT_SHA}}` |
| Analysis run | `{{ANALYSIS_RUN_ID}}` (reviewed — read only) |
| Sandbox issues already created | `{{SANDBOX_ISSUES_SO_FAR}}` (counts toward the cap of 2) |
| Ledger snapshot | `{{LEDGER_SINCE}}` |

## Do

S1–S24 in order, **in the UI first**, as the plan's table says: its "Drive it with" column
names the UI control for each step and marks the few checks that are *API only*. Use in-page
`fetch('/api/projects/{{PROJECT_ID}}/spec-kit/…', {credentials:'include', …})` **only** for
those; anything else that needs `fetch` is a finding. Chat no longer runs or suggests Spec Kit
commands (#931).

- **S9 handoff:** **Start analysis with these artifacts** once. It must start a new run, never
  `{{ANALYSIS_RUN_ID}}`; record its ID and cost, with test custom agents disabled first.
- **S21:** the dry run lists the titles and the target repo; Publish stays disabled with the
  "not available on this server yet" reason until #953 lands. Keep the sandbox slot. If
  Publish is enabled, #953 has landed: publish within the 2-issue cap, to `openzigs/flux-v2` only.

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- **`taskstoissues` publishes to the project's saved target.** The UI sends no repo (#784
  made the saved target the default). Before **Publish**, confirm the saved target is
  `openzigs/flux-v2` and the dry run names only that repo; stop if it names any other.
- The UI publishes **one issue per task**. Publish for real only when the dry run lists no
  more issues than the run's cap of 2 has left. Otherwise, make a throwaway feature, cut its
  `tasks.md` to fit with `PUT …/features/:slug/artifacts/tasks.md` (*API only*), and
  preview and publish that one. Or record S21's real run as `skipped (cap)`.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min). Drive the page; keep in-page `fetch` for the *API only*
checks. Fetch exports instead of clicking download buttons. A second user (S3b, S12) needs
`browser.newContext()`. Wait 20–40 s after a dev-mode navigation before
snapshotting.

**Scratch files go in `{{SCRATCH_DIR}}/wave-d/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-d/`.

## Step manifest — one line per screenshot (#829)

Every screenshot you keep also gets **one JSON line appended** to
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/steps.jsonl` (the run folder, not the wave
folder; waves run in sequence, so appending is safe). The run's tutorial and report slideshows
are built from it. Schema: the `e2e-walkthrough` skill, section 7.

```json
{"id":"d-S4-1","wave":"D","phase":"S4","chapter":"Connect a repository","title":"Add the repo connector","screenshot":"wave-d/02-connector.png","tutorial":"Open **Connectors**, choose **Add connector**, paste the repository URL and set **Branch or tag** to `v2.3.3`.","result":"Connector created; lastCommitSha c4d54f87. 41 s.","works":"pass","useful":"pass","issues":[714],"tokens":1830,"costCents":0.21,"ts":"2026-10-03T09:12:00Z"}
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

1. **State hand-off**: the Spec Kit feature IDs, the artifact list produced, the S9 handoff
   analysis ID, the URLs of any
   sandbox issues created, and the ledger snapshot timestamp at the end of the wave.
2. **Per-step table** (one row per S-step, same columns):

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix under "Fixes to verify this wave": fix | PR | confirmed / partial / regressed / not-exercised | step id.
4. **Findings** — one line each: severity, step, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
