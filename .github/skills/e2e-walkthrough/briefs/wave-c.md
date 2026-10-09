# Wave C — Phases 9–13 (run {{RUN_NUMBER}})

You are wave C of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md) for the definition and pass bars of
Phases 9–13 (docs generation, chat, discussions, publishing, drift / scheduler / tasks).

## State you start from

| Key | Value |
|---|---|
| UI / API | `{{UI_URL}}` / `{{API_URL}}` |
| Project / workspace | `{{PROJECT_ID}}` / `{{WORKSPACE_ID}}` |
| Repo connector / graph | `{{REPO_CONNECTOR_ID}}` / `{{CODE_GRAPH_ID}}` at `{{COMMIT_SHA}}` |
| Analysis run | `{{ANALYSIS_RUN_ID}}` (reviewed — read only) |
| Requirement set | `{{REQUIREMENT_SET_ID}}` |
| Repo source documents after wave A | `{{REPO_DOC_COUNT}}` |
| Ledger snapshot | `{{LEDGER_SINCE}}` |

## Do

Phases 9–13 as the plan defines them. Docs generation dominated the spend in run 2 (80%) and
run 3 (89%, $8.73). Snapshot the ledger immediately before and after each document so its
cost is attributable. Phase 12 is the only phase allowed to publish, and only under the rules
below.

**Order matters:** finish Phase 9's documents before you create or run anything in Phase 13.
In run 3, a scheduled repo refresh during the BRD failed it at commit after 88 min and $4.61
(#856). Keep every scheduled job paused until Phase 9 is done.

**One BRD attempt.** If a document runs long, stop it with **Cancel generation**, which keeps
its finished sections (#855). Don't regenerate it in a second full run, and don't ask the
operator to restart the server. Record the wall time, cost and final size. #741 caps a
section at 60k characters and a document at 250k; run 3's BRD was 2.19 MB.

## Added steps (run 4)

**Phase 9 — measure docs generation against its caps (#855, #741; PR #867).** Record the
`DOCS_GEN_MAX_RUN_COST_CENTS` in force (default 2500; the skill suggests 500 for a walkthrough),
`DOCS_GEN_MAX_RUN_TOKENS` (default 20M), `DOCS_GEN_SECTION_MAX_CHARS` (default 60,000) and
`DOCS_GEN_DOCUMENT_MAX_CHARS` (default 250,000). For each document report: cost against the cost
ceiling; whether a ceiling stopped it (a degraded draft whose warning names the ceiling);
the exported body's length and its longest section, both in characters; and any "topics left
out" note.
- Expected: no section over the section cap and no body over the document cap; text is never
  cut mid-sentence.
- **Cancel once on purpose.** Regenerate the architecture document; after its first section
  finishes, click **Cancel generation**. Expected: the status leaves `generating` within a
  minute, the ledger stops growing, and the finished sections are kept. A second regenerate
  lists the sections it reused (#857). Record the spend of both attempts.
- The database document's model calls appear in the ledger under `docs-gen` (#858, PR #869).

**Phase 10 — a follow-up keeps its citations (#773, PR #923).** In one project-scoped session,
ask BA question 1, then follow up with `Show me the exact lines for the first citation`.
- Expected: the follow-up keeps the earlier verified `file:line` and does not say it "had not
  actually read" the file.
- Use the UI if the project scope can be selected; otherwise send both turns to the same
  session over `POST /api/ai/chat`.

**Phase 11.** The @mention picker offers only users who can open the project (#870, PR #879).
The notification names the author and opens the comment (#735, PR #869).

**Phase 12 — publishing (#863, PR #922).** All on `openzigs/flux-v2`, dry run first, inside the
cap of 2.
- Publish one batch. Expected: its draft is no longer selected afterwards, and the next batch
  preview does not fail with `DRAFT_INELIGIBLE`.
- **Archive** a settled batch from the batch row (`archive-batch-<id>`), then confirm with a reason.
  It leaves the list. Leave **Also close the issues** unticked; wave D may still need them.
- No draft title reads `[Feature] [Feature]: …`. Count the doubled titles; expected 0.
- Drafts from the Phase 6 GitHub import carry the upstream issue's acceptance criteria when the
  issue has an "Acceptance criteria" heading. Name one issue checked each way.
- Generating drafts from an import of more than 25 requirements opens the requirement picker
  (`draft-requirement-picker`) instead of drafting them all. Pick 3.
- `/reviews`: a review started in Phase 8 is listed (#732, PR #929).

**Phase 13 — refresh on an unchanged commit (after Phase 9).** After the manual
`refresh-ingest`, the code graph is not re-created (same graph ID, #856), and the repo
connector's source-document count still equals `{{REPO_DOC_COUNT}}`: the refresh prunes only files absent from
the checkout (#756, PR #892).

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Standing rules — never

- Never start a repo refresh, re-ingest or scheduler job while a document is generating.

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run — `{{ANALYSIS_RUN_ID}}` is one.
- Never **reject** approval items on a run that is still needed (#723).
- Never run Spec Kit `taskstoissues` without the sandbox repo set explicitly.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
  Real publishing needs the operator's auto-mode allow rule; if it is blocked, stop and
  report — do not route around it.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min). Drive the UI, and keep in-page `fetch` for the ledger and
for exports. **Fetch doc
exports — clicking a download button crashes the Playwright page.** Wait 20–40 s after a
dev-mode navigation before snapshotting. A second user (Phase 11 mentions) needs
`browser.newContext()`; mock users exist only after their first login, and a workspace
membership change needs `/api/auth/refresh` before the claim updates.

**Scratch files go in `{{SCRATCH_DIR}}/wave-c/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-c/`.

## Step manifest — one line per screenshot (#829)

Every screenshot you keep also gets **one JSON line appended** to
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/steps.jsonl` (the run folder, not the wave
folder; waves run in sequence, so appending is safe). The run's tutorial and report slideshows
are built from it. Schema: the `e2e-walkthrough` skill, section 7.

```json
{"id":"c-2-1","wave":"C","phase":"2","chapter":"Connect a repository","title":"Add the repo connector","screenshot":"wave-c/02-connector.png","tutorial":"Open **Connectors**, choose **Add connector**, paste the repository URL and set **Branch or tag** to `v2.3.3`.","result":"Connector created; lastCommitSha c4d54f87. 41 s.","works":"pass","useful":"pass","issues":[714],"tokens":1830,"costCents":0.21,"ts":"2026-10-03T09:12:00Z"}
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

1. **State hand-off**: document IDs, chat session IDs, the URLs of any sandbox issues
   created, the docs-gen caps table (per document: cost, ceiling hit, body and longest-section
   characters), and the ledger snapshot timestamp at the end of the wave.
2. **Per-phase table**:

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix under "Fixes to verify this wave": fix | PR | confirmed / partial / regressed / not-exercised | step id.
4. **Findings** — one line each: severity, phase, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
