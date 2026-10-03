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

S1–S24 in order. Per-feature `speckit.*` commands and `/features*` routes have no UI
caller; exercise them with in-page `fetch('/api/projects/{{PROJECT_ID}}/spec-kit/…',
{method:'POST', credentials:'include', …})` and record the missing UI as a finding if it
is still missing. For `/specify` and `/plan`, record the grounding count K.

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- **Never run `taskstoissues` without the sandbox repo `openzigs/flux-v2` set explicitly
  in the request** — run 2 found it ignored the saved target (#784). Dry run first, and
  stop if the dry run names any other repo.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min) and drive the API with in-page `fetch`. Fetch exports
instead of clicking download buttons. Wait 20–40 s after a dev-mode navigation before
snapshotting.

**Scratch files go in `{{SCRATCH_DIR}}/wave-d/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-d/`.

## Return

1. **State hand-off**: the Spec Kit feature IDs, the artifact list produced, the URLs of any
   sandbox issues created, and the ledger snapshot timestamp at the end of the wave.
2. **Per-step table** (one row per S-step, same columns):

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix in `{{FIXES_TO_VERIFY}}`: fix | PR | holds / regressed | evidence.
4. **Findings** — one line each: severity, step, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
