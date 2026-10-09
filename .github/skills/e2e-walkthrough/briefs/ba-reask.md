# BA re-ask — the 8 BA questions over the API (run {{RUN_NUMBER}})

You re-ask the eight Business Analyst questions from the "Persona scenarios" section of
[`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md) through the chat API, and check every
answer's citations against the `v2.3.3` ground truth. No browser is needed.

## State you start from

| Key | Value |
|---|---|
| API | `{{API_URL}}` (authenticated as `{{LOGIN_USER}}`; cookie jar `{{COOKIE_JAR}}`) |
| Project / workspace | `{{PROJECT_ID}}` / `{{WORKSPACE_ID}}` |
| Ground truth checkout | `{{GROUND_TRUTH_DIR}}` (`git clone --depth 1 --branch v2.3.3 https://github.com/miniflux/v2`) |
| Ledger snapshot | `{{LEDGER_SINCE}}` |

## Do

For each question N in 1–8, **one fresh project-scoped session each** (a shared session lets
earlier answers leak into later ones):

1. `POST /api/ai/sessions` with `{"projectId":"{{PROJECT_ID}}","title":"BA Q<N> run {{RUN_NUMBER}}"}`.
2. `POST /api/ai/chat` with `{"sessionId":"<id>","message":"<question N verbatim from the plan>"}`.
3. Save the raw response to `{{SCRATCH_DIR}}/ba-reask/q<N>.json`, and the wall time.
4. Open every cited `file:line` in the ground-truth checkout and mark it correct or not.

Log in once — logins are limited to 20 per 15 min.

Since #861 (PR #869), a tool call that needs approval is refused at once when no chat is open,
and the response lists it under `toolApprovals`; the answer comes without it. Record any
`toolApprovals` per question. A call that stalls for about 120 s is a regression.

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`; the questions are about it, not to it.
- Never click **Regenerate** on a reviewed run (`{{ANALYSIS_RUN_ID}}`).
- Never **reject** approval items on a run that is still needed (#723).
- Never run Spec Kit `taskstoissues` without the sandbox repo set explicitly.
- Any publish is a **dry run first** — and this step has no reason to publish at all.

**Scratch files go in `{{SCRATCH_DIR}}/ba-reask/` only.**

## Return

1. **Per-question table**: Q | Key claim | Citation | Verified (✅/❌) | Wall time | Hit the tool-call limit? | `toolApprovals`
2. **Totals**: answered N/8, correct with a valid citation N/8 (pass bar ≥ 6; run 2 after
   #783: 8/8).
3. **Per-phase cost row** (the BA re-ask is one row in the results table):

   | Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful |
   |---|---|---|---|---|---|---|---|---|

   Console errors is `–` here (no browser).
4. **Fix verification** — for each fix under "Fixes to verify this wave": fix | PR | confirmed / partial / regressed / not-exercised | step id.
5. **Findings** — one line each: severity, question, symptom, evidence path. Do not file issues.
6. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
