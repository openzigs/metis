# Wave F — persona journeys, UI only (run {{RUN_NUMBER}})

You are wave F of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read the **Journeys**
section of [`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md): its
rules, journey 1 (business analyst "Priya") and journey 2 (developer "Dev"), each step's "must
hold" column, the handoffs to check and the budgets.

Waves A–E tested features one at a time. You test whether a **person** can get from a starting
point to an outcome. Act as the persona: you know what they know and nothing more.

**Journey 1 is the core of the run (#1177).** METIS is built mainly for business analysts, so
give J1 the time: it now has a reviewer who rejects and then approves, a second analyst who
comments, mentions and discusses on the same project (J1.4a to J1.4c), a BRD checked as a Word
and PDF deliverable (J1.7), and a Jira publish once the sandbox Jira exists (J1.8a).

## What the personas know

| Key | Value |
|---|---|
| UI | `{{UI_URL}}` |
| Workspace (by name) | `{{WORKSPACE_NAME}}` |
| Journey 1's new project (Priya names it) | `{{J1_PROJECT_NAME}}` |
| Journey 2's project (by name, from wave A) | `{{PROJECT_NAME}}` |
| Priya signs in as | `admin` |
| Reviewer (already a workspace member) | `coordinator` |
| Second analyst, Sam (already a workspace member) | `developer` |
| Second-user mode | `{{SECOND_USER_MODE}}` (`operator-approved` or `operator-run`) |
| Start at step | `{{J1_RESUME_AT}}` (`J1.1` on the first dispatch) |
| Sandbox repo | `openzigs/flux-v2` |
| Sandbox issues already created this run | `{{SANDBOX_ISSUES_SO_FAR}}` (counts toward the cap of 2) |
| Ledger snapshot before wave F | `{{LEDGER_SINCE}}` |

No project, run or requirement IDs are given on purpose. Find everything through the UI.

Notes from run 8: Journey 1's 5 items become about 34 requirements and the harness refuses a
scripted bulk rejection, so decide up front whether to approve all; the journey ran 43 of its
45 minutes with no idle time. Take **viewport** screenshots on analysis pages (a full-page
capture of the Traceability tab crashes Chrome). In `steps.jsonl` the `useful` field is
`pass`, `weak`, `fail` or `n/a` only, never `partial`. Wave D and wave F own the two real
sandbox slots; wave C does not.

## Do

1. **Journey 1, then journey 2**, step by step as the plan's tables define them, starting at
   `{{J1_RESUME_AT}}` (on a re-dispatch, everything before it is done: check its handoffs, then
   carry on). Before J1.1 and J2.1, note the wall-clock time and snapshot the ledger (section 5
   of the skill); do the same after the last step. That measurement, and fetching J1.7's
   exports by URL (below), are the only non-UI actions allowed.
2. **[2nd user] steps** (every action marked so in J1.4a to J1.4c) follow the plan's
   "Second-user steps". In the UI the users are **System Admin** (Priya, you), **Test
   Coordinator** (the reviewer) and **Test Developer** (Sam).
   - With `operator-approved`, drive the second user in its own browser context
     (`browser.newContext()`, signed in as `coordinator` or `developer`, password `password`),
     and watch the live and presence checks from Priya's page as they happen. If that call is
     refused, stop there as for `operator-run`.
   - With `operator-run`, **stop before J1.4a** and return `Operator steps pending: J1.4a, J1.4b,
     J1.4c` with the exact text of the three rows, plus everything finished so far. The two users'
     actions interleave live, so the operator does all three steps, Priya's part included, with
     an `admin` window as the observer, and re-dispatches you with `J1.5` as the start. Then read
     `.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/operator/notes.md`, record one
     `steps.jsonl` line per operator step with the operator's observation as its `result` and
     screenshot, and check the lasting results from Priya's own screen: the requirement's
     versions in History, both reviews' statuses, the comments, the thread and the notifications.
     A live or presence check the notes do not report is `not-exercised (operator-run)`, never a
     pass on what a reload shows.
   - Put `operator-run`, `operator-approved` or `agent` in each step's `result`. Never sign in a
     second user any other way, and never act as them through the API or SQL.
3. **J1.7's BRD is a deliverable.** Fetch its Word and PDF exports by URL as the plan's Phase 9
   says (`GET /api/projects/:projectId/docs/:docId/export?format=docx`, `pdf` and `markdown`
   from the signed-in page; a Download click crashes the page), save them under the wave's
   evidence folder and open them. Score the markdown export on the sign-off rubric (SO1–SO4,
   J1.7 readings).
4. **J1.8a (Jira) is conditional on #1176.** If no sandbox Jira is configured for the project,
   record the step `skipped: no sandbox Jira (#1176)` and go on; never configure one yourself.
5. After every step, run its **handoff check**: open the thing the persona made in the previous
   step and confirm it survived (same title, edited text, links, labels). Record what was lost.
6. **A step the UI cannot do is a finding, not a detour.** Record it `works: "blocked"` with the
   missing control named, then continue with the next step that does not depend on it. Never
   fall back to `fetch()`, SQL, or an ID from an earlier wave.
7. **Journey 1 publishes** within the run's cap of 2: dry run first, sandbox only. If the cap is
   used up, dry-run only and say so. Journey 2's task export follows the same cap.
8. **Score J2.1 (impact) and J2.4 (Spec Kit plan)** against #4336's reference change set in
   the plan ("Reference change sets"), by its "Scoring a change plan" rules, exactly as wave E
   scores its outputs: file and function `tp` / `fp` / `fn`, migration correct, false
   positives by name, and the step's "must hold" verdict beside them. **J2.1 is two rows**
   (#1073): its edit candidates (the **Files to edit** group) on precision and recall, and its
   blast radius (Files to edit and the opened **Blast radius** group together) on **recall
   only**, with `tp` and `fn` and no `fp`. **Record `listed` on the blast row's `files` and
   `functions`**: how many distinct files, and distinct functions, the blast radius listed (both
   groups together) once the set's neutral items, test files and generated files are removed; a
   count, never a ratio or a score, and never below `tp`. If the page has no Files to edit group
   and no "directly affected" wording, the edit list is empty: record the edit row as `tp` 0,
   `fp` 0, `fn` = the set's size and score the blast row from the Blast radius group (the plan's
   "Scoring a change plan" has the rule for a page from before #1036). J2.4's plan is one row,
   as before. Scoring reads the persona's own screen; it is not a non-UI action.

   **Swapping J2's request.** J2 stays on #4336 by default, so runs compare like for like. A
   run may swap it to one of the bug reports fixed upstream (#4479, #4386 or #4456, #1044), whose
   change sets are upstream truth: Dev pastes that issue's title and body (never its fixing PR)
   in place of #4336's, the #4336-specific "must hold" cells (J2.1's `read_at` writers, J2.3's
   "what about Fever and Google Reader?") read against that request's "must surface" row, and J2.1 and J2.4 are scored against **that** request's reference change set by the
   same rules, with `source` `upstream`. Name the swap in the journey's verdict and in the
   change-plan rows' `issue`, and do not compare its scores with an earlier run's #4336 rows.
9. Verify the fixes listed below as you pass the step each one names.

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Standing rules — never

- Never publish, comment or review on `miniflux/v2`. Sandbox is `openzigs/flux-v2` only.
- No `fetch()`, no SQL, no API calls and no IDs from earlier waves for a persona step. The one
  exception is fetching J1.7's exports by URL (Do, item 3), which stands in for a Download click.
- Never click **Regenerate** on a reviewed run.
- Never **reject** approval items on a run that is still needed (#723).
- Every publish is a **dry run first**; at most 2 real sandbox issues in the whole run.
- Use the GitHub token only through the METIS vault picker.

## Tips

Log in once (20 logins / 15 min). Wait 20–40 s after a dev-mode navigation before
snapshotting. A second user needs its own browser context, and only in `operator-approved` mode;
the operator's setup signed both in once, so they exist. After a membership change
`/api/auth/refresh` refreshes the workspace claim (an operator step, not Priya's). Clarification starts when the Questions tab opens: do not remount
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

0. **`Operator steps pending: <step ids>`** first, if you stopped for one, with each step's text
   for the operator; then everything below for the steps you did.
1. **Per journey**: completed in the UI (yes / no, and the step where it broke), data lost
   between steps (which handoff, what was lost), wall time and ledger cost against the budget.
   For journey 1 also: the wall time of the [2nd user] steps on its own line, and the J1.7
   **sign-off line** (`Sign-off — J1.7 BRD: SO1 … · SO2 … · SO3 … · SO4 …`), and per export
   format (markdown, docx, pdf): status, content type, size, first bytes, and whether it opened
   with the five requirement headings.
2. **Per step**: step | Works | Useful | handoff held? | second user ran as (J1.4a–J1.4c) | evidence path.
   Journey 2 adds its change-plan rows: two for `j2-impact` (J2.1), scope `edit` and scope
   `blast`, and one for `j2-plan` (J2.4), whose scope cell is `–`. A `blast` row gives recall
   only: `tp` and `fn`, with `–` for `fp` and for the false positives.

   | Issue | Output | Scope | File P/R (tp/fp/fn) | Function P/R (tp/fp/fn) | Migration correct | Must hold | False positives |
   |---|---|---|---|---|---|---|---|

   These go into `run.json` `changePlanAccuracy` (the skill, section 7).
3. **Fix verification** — for each fix listed above: fix | PR | confirmed / partial / regressed /
   not-exercised | step id.
4. **Findings** — one line each: severity, journey step, symptom, evidence path. Do not file
   issues.
5. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
