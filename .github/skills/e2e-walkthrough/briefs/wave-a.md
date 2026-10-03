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
