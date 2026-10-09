# Wave F — persona journeys, UI only (run {{RUN_NUMBER}})

You are wave F of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read the **Journeys**
section of [`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md): its
rules, journey 1 (business analyst "Priya") and journey 2 (developer "Dev"), each step's "must
hold" column, the handoffs to check and the budgets.

Waves A–E tested features one at a time. You test whether a **person** can get from a starting
point to an outcome. Act as the persona: you know what they know and nothing more.

## What the personas know

| Key | Value |
|---|---|
| UI | `{{UI_URL}}` |
| Workspace (by name) | `{{WORKSPACE_NAME}}` |
| Journey 1's new project (Priya names it) | `{{J1_PROJECT_NAME}}` |
| Journey 2's project (by name, from wave A) | `{{PROJECT_NAME}}` |
| Reviewer Priya invites | `coordinator` |
| Sandbox repo | `openzigs/flux-v2` |
| Sandbox issues already created this run | `{{SANDBOX_ISSUES_SO_FAR}}` (counts toward the cap of 2) |
| Ledger snapshot before wave F | `{{LEDGER_SINCE}}` |

No project, run or requirement IDs are given on purpose. Find everything through the UI.

## Do

1. **Journey 1, then journey 2**, step by step as the plan's tables define them. Before J1.1
   and J2.1, note the wall-clock time and snapshot the ledger (section 5 of the skill); do the
   same after the last step. That measurement is the only non-UI action allowed.
2. After every step, run its **handoff check**: open the thing the persona made in the previous
   step and confirm it survived (same title, edited text, links, labels). Record what was lost.
3. **A step the UI cannot do is a finding, not a detour.** Record it `works: "blocked"` with the
   missing control named, then continue with the next step that does not depend on it. Never
   fall back to `fetch()`, SQL, or an ID from an earlier wave.
4. **Journey 1 publishes** within the run's cap of 2: dry run first, sandbox only. If the cap is
   used up, dry-run only and say so. Journey 2's task export follows the same cap.
5. Verify the fixes listed below as you pass the step each one names.

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- No `fetch()`, no SQL, no API calls and no IDs from earlier waves for a persona step.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min). Wait 20–40 s after a dev-mode navigation before
snapshotting. The reviewer needs `browser.newContext()`; mock users exist only after their first
login, and after a membership change `/api/auth/refresh` refreshes the workspace claim (an
operator step, not Priya's). Clarification starts when the Questions tab opens: do not remount
it while it starts (#937).

**Scratch files go in `{{SCRATCH_DIR}}/wave-f/` only.** Evidence goes in
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-f/`.

## Step manifest — one line per screenshot (#829)

Every screenshot you keep also gets **one JSON line appended** to
`.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/steps.jsonl`. Schema: the `e2e-walkthrough`
skill, section 7. For wave F, `wave` is `"F"`, `phase` is the journey step (`"J1.4"`) and
`chapter` is exactly `"Journey: Business analyst"` or `"Journey: Developer"`.

```json
{"id":"f-j1-4-1","wave":"F","phase":"J1.4","chapter":"Journey: Business analyst","title":"Approve the checkpoint","screenshot":"wave-f/j1-4-approve.png","tutorial":"On **Requirements**, open the **Approvals** checkpoint and choose **Approve**; each requirement then reads **Approved**.","result":"Checkpoint approved; 5/5 requirements read Approved with no second click (#939 holds).","works":"pass","useful":"pass","issues":[939],"ts":"2026-10-03T09:12:00Z"}
```

`tutorial` speaks **to a user, about the task**; `result` speaks to the reviewer, about what
happened. A blocked step still gets a line and a screenshot of where the persona got stuck.

## Return

1. **Per journey**: completed in the UI (yes / no, and the step where it broke), data lost
   between steps (which handoff, what was lost), wall time and ledger cost against the budget.
2. **Per step**: step | Works | Useful | handoff held? | evidence path.
3. **Fix verification** — for each fix listed above: fix | PR | confirmed / partial / regressed /
   not-exercised | step id.
4. **Findings** — one line each: severity, journey step, symptom, evidence path. Do not file
   issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
