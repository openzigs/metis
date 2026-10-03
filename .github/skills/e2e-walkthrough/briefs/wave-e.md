# Wave E — Phases 15–20 + developer-issue impact (run {{RUN_NUMBER}})

You are wave E of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[#706](https://github.com/openzigs/metis/issues/706) for Phases 15–20 (PR review, impact,
test coverage, usage and cost, settings, admin) and the "Developer: real open Miniflux
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
3. Phase 18: compare the Usage page with the ledger queries in the skill; a mismatch is a
   finding.

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
