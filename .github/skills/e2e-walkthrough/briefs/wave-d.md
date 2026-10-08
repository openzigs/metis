# Wave D — Spec Kit S1–S24 (run {{RUN_NUMBER}})

You are wave D of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read the
"Spec Kit (Phase 14, in full)" section of
[#706](https://github.com/openzigs/metis/issues/706) for steps S1–S24 and their pass bars.
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

S1–S24 in order, **in the UI first**. Since #931 the Spec Kit page
(`/projects/{{PROJECT_ID}}/spec-kit`) has a **Features** panel, a `speckit.*` command palette
that runs on the selected feature, **Generate checklists**, issue export after a dry run,
artifact **Delete** and **Start analysis** after `/speckit.implement`. Chat no longer runs or
suggests Spec Kit commands. Use in-page `fetch('/api/projects/{{PROJECT_ID}}/spec-kit/…',
{credentials:'include', …})` **only** for the checks marked *API only* below. Each of those has
no UI caller in `ui/src`; anything else that needs `fetch` is a finding.

#706's table predates #928 and #931. Where it disagrees, these run-4 expectations win:

| Step | Drive it with | Expected (run 4) |
|---|---|---|
| S1 | UI: the page before enabling. *API only:* `POST …/commands/speckit.specify` | `spec-kit-disabled-banner` shows and the palette is disabled; the API call returns **409 `SPEC_KIT_DISABLED`** |
| S2 | UI: `spec-kit-toggle` | Persists across a reload; the onboarding card shows |
| S3 | UI: **Generate constitution.md** | **Grounded (#928):** the success toast, not a warning; principles name their sources (README, `go.mod`, contributing guide) and reflect Go stdlib-first, Postgres only, no JS frameworks. A skeleton with a "nothing relevant ingested" warning is a FAIL here, because Phase 3 ingested the README |
| S3b | UI: open the page as `developer` in a second context. *API only:* the 403 | **Read-only (#931):** every write control is disabled with the tooltip "Requires project.update"; the API returns **403** for `developer` and 200 for `admin`. `speckit.constitution.write` no longer exists (#928) |
| S4 | UI: select **Project**, run `/speckit.specify mark all entries as read older than N days` | Creates a feature and its `spec.md`; the toast reads `Generated spec.md (vN) for <slug> in T tokens — grounded on …` with **K > 0**. Must mention `MarkAllAsReadBeforeDate` |
| S5–S9 | UI: select the new feature, then `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.analyze`, `/speckit.implement` | Each artifact appears under `specs/<slug>/` (`spec-kit-feature-tree`). `/speckit.plan` writes 5 plan artifacts and says it is grounded, citing real `path:start-end` spans (#853). `/speckit.implement` shows the **handoff** card listing the artifacts |
| S9 handoff | UI: **Start analysis with these artifacts**, once | A new analysis run starts (never `{{ANALYSIS_RUN_ID}}`); record its ID and cost. Disable test custom agents first so it stays cheap |
| S10 | UI: **Edit** / **Save** / **Cancel** on `constitution.md` (project `.specify/` files only). *API only:* a body over 200,000 chars | Version increments; cancel changes nothing; the oversized body gets 400. Feature artifacts have no Edit button: that is by design, so it is not a finding |
| S11 | UI: **Delete** `clarify.md` in the feature, confirm | It leaves the feature tree; the toast names the file |
| S12 | UI: **Comments** on `constitution.md`, mention `coordinator`; presence in a second context | Comments and presence exist on project `.specify/` artifacts only. The mention notifies and opens the artifact's comments (#735) |
| S13 | UI: type `/` in the palette; type `/` in `/chat` | The palette suggests the **nine `speckit.*` commands**, not the six legacy names. `/chat` suggests no Spec Kit command (#931) |
| S14 | *API only:* `POST …/commands/specify` | `Deprecation: true` and `Link: <…/commands/speckit.specify>; rel="successor-version"`. The palette maps a typed `/specify` to `speckit.specify`, so the header is unreachable from the UI |
| S15 | UI (S4) | `GET …/features` and the Features selector list the feature |
| S16 | UI: `/speckit.plan` with **Project** selected. *API only:* the 400 | The page refuses before sending ("Select a feature first"); the API returns **400 `SPECKIT_FEATURE_REQUIRED`** without `featureSlug`, then 200 with it |
| S17 | UI: list and read in the feature tree. *API only:* `PUT …/features/:slug/artifacts/*key`, and an unknown slug | Round trip OK; the unknown slug returns 404 `SPECKIT_FEATURE_NOT_FOUND` |
| S18 | UI: the gate list in the Features panel (`spec-kit-feature-gates`) | `spec`, `plan`, `tasks`, `implement` gates match what exists |
| S19 | UI: **Generate checklists** once right after S4, before `/speckit.plan`, and again after it. *API only:* adding a reviewer line to a checklist (feature artifacts have no Edit) | **412** before `plan.md`, its message shown in `spec-kit-error`. After: five domain checklists **specific to this feature** (#925), for example a bounded `UPDATE` on `entries` or an index on `published_at`. Re-run (merge is the default): the reviewer's line and its tick survive below the regenerated items |
| S20 | UI (S5–S9 already ran the namespaced commands) | No `Deprecation` header on any of them |
| S21 | UI: **Preview issue export (dry run)**, then **Publish issues to the saved target** | See the `taskstoissues` rule below. The publish button stays disabled until a dry run of the current `tasks.md` |
| S22 | UI: **Archive**, tick **Show archived**, **Restore** | Hidden, then shown, then back |
| S23 | *API only:* `POST …/spec-kit/install` | **501 `SPECKIT_ATTACHED_WORKSPACE_NOT_IMPLEMENTED`**. Expected; do not file it |
| S24 | *(Optional; needs a public webhook)* close a sandbox issue from S21 | The matching `tasks.md` item is ticked |

`x-speckit-force: 1` (gate bypass) is a header, so it is *API only* too.

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
3. **Fix verification** — for each fix in `{{FIXES_TO_VERIFY}}`: fix | PR | holds / regressed | evidence.
4. **Findings** — one line each: severity, step, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
