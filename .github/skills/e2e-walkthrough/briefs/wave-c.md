# Wave C — Phases 9–13 (run {{RUN_NUMBER}})

You are wave C of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read
[#706](https://github.com/openzigs/metis/issues/706) for the definition and pass bars of
Phases 9–13 (docs generation, chat, discussions, publishing, drift / scheduler / tasks).

## State you start from

| Key | Value |
|---|---|
| UI / API | `{{UI_URL}}` / `{{API_URL}}` |
| Project / workspace | `{{PROJECT_ID}}` / `{{WORKSPACE_ID}}` |
| Repo connector / graph | `{{REPO_CONNECTOR_ID}}` / `{{CODE_GRAPH_ID}}` at `{{COMMIT_SHA}}` |
| Analysis run | `{{ANALYSIS_RUN_ID}}` (reviewed — read only) |
| Requirement set | `{{REQUIREMENT_SET_ID}}` |
| Ledger snapshot | `{{LEDGER_SINCE}}` |

## Do

Phases 9–13 as #706 defines them. Docs generation dominated run 2's spend (80%); snapshot
the ledgers immediately before and after each document so its cost is attributable.
Phase 12 is the only phase allowed to publish, and only under the rules below.

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- Never click **Regenerate** on a reviewed run — `{{ANALYSIS_RUN_ID}}` is one.
- Never **reject** approval items on a run that is still needed (#723).
- Never run Spec Kit `taskstoissues` without the sandbox repo set explicitly.
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
  Real publishing needs the operator's auto-mode allow rule; if it is blocked, stop and
  report — do not route around it.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min) and drive the API with in-page `fetch`. **Fetch doc
exports — clicking a download button crashes the Playwright page.** Wait 20–40 s after a
dev-mode navigation before snapshotting. A second user (Phase 11 mentions) needs
`browser.newContext()`; mock users exist only after their first login, and a workspace
membership change needs `/api/auth/refresh` before the claim updates.

**Scratch files go in `{{SCRATCH_DIR}}/wave-c/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-c/`.

## Return

1. **State hand-off**: document IDs, chat session IDs, the URLs of any sandbox issues
   created, and the ledger snapshot timestamp at the end of the wave.
2. **Per-phase table**:

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Works / Useful: ✅ pass · ⚠️ partial or weak · ❌ fail · 🚫 blocked (with reason) · – n/a.
3. **Fix verification** — for each fix in `{{FIXES_TO_VERIFY}}`: fix | PR | holds / regressed | evidence.
4. **Findings** — one line each: severity, phase, symptom, evidence path. Do not file issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
