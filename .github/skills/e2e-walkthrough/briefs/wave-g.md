# Wave G — implement the plan, optional (run {{RUN_NUMBER}})

You are wave G of run {{RUN_NUMBER}} of the METIS end-to-end walkthrough. Read the **"Wave G —
implement the plan (optional)"** section of
[`docs/walkthroughs/TEST_PLAN.md`](../../../../docs/walkthroughs/TEST_PLAN.md), and its
"Reference change sets" and "Scoring a change plan" sections, which score your diff.

Waves D and F proved METIS can write a Spec Kit `tasks.md`. You prove whether that plan
**produces working code**: implement it, task by task, on a branch of the sandbox fork, then
build and test it. You are an implementing agent, not `ui-vision`: no browser, no METIS UI.

## State you start from

| Key | Value |
|---|---|
| Feature request | Miniflux `#{{FEATURE_ISSUE}}` (`https://github.com/miniflux/v2/issues/{{FEATURE_ISSUE}}`) |
| `tasks.md`, exported from METIS | `{{TASKS_PATH}}` |
| `plan.md`, exported from METIS | `{{PLAN_PATH}}` |
| Sandbox fork | `openzigs/flux-v2` (`https://github.com/openzigs/flux-v2.git`) |
| Base commit | `c4d54f87` (= Miniflux `v2.3.3`; the fork has no `v2.3.3` tag, so use the SHA) |
| Branch to create | `walkthrough/run-{{RUN_NUMBER}}-{{FEATURE_ISSUE}}` |
| Budget | about **$3** of your own LLM spend or **45 minutes**, whichever comes first |

## Do

1. **Note the wall-clock start** and your own usage so far. Your spend is measured from your
   own usage, not from METIS's `token_usages`.
2. **Set up.** Clone into `{{SCRATCH_DIR}}/wave-g/flux-v2`, then
   `git checkout -b walkthrough/run-{{RUN_NUMBER}}-{{FEATURE_ISSUE}} c4d54f87`.
   Miniflux `v2.3.3` declares `go 1.26.0` in `go.mod`: check `go version` first. A toolchain
   that cannot build the base commit is an environment problem; stop and say so before task 1.
3. **Implement the tasks in `tasks.md` in order, one commit per task**, each message starting
   with its task id (`T003: …`). Implement each task **as written**.
4. **The correction rule.** Where a task is wrong, missing or ambiguous, still finish the change
   so the feature works, but record the task as **needed correction**, with a one-line reason
   (for example "T004 adds a `users` column; `MarkAllAsReadBeforeDate` already exists"). A task
   you had to add counts too: record it as `+ <what>` with its reason.
5. **Prove it.** From the repository root run `go build ./...`, `go vet ./...` and
   `go test ./...`. The API integration tests skip unless `TEST_MINIFLUX_*` is set, so no running
   Miniflux or database is needed. Record each exit code, and the failing package names.
6. **Score the diff** `git diff c4d54f87..HEAD` against `#{{FEATURE_ISSUE}}`'s reference change
   set, by the plan's "Scoring a change plan" rules: file and function `tp` / `fp` / `fn`. Test
   files are excluded from both sides, so count the new tests separately.
7. **Push the branch** (guard-rails below), then note the wall-clock end and your usage.

**Budget stop.** At about $3 or 45 minutes, stop where you are, commit what exists, push it and
score it. A stop before the build is `builds: not reached`, not a fail of METIS.

## Fixes to verify this wave

{{FIXES_TO_VERIFY}}

## Guard-rails — never

- Write **only** to `openzigs/flux-v2`, and **only** by pushing your branch. **No pull
  requests**, no issues, no comments and no reviews on any repository, and **nothing at all on
  `miniflux/v2`**.
- Before pushing, confirm the remote: `git remote get-url origin` must be
  `https://github.com/openzigs/flux-v2.git` (or `git@github.com:openzigs/flux-v2.git`). Push with
  `git push origin walkthrough/run-{{RUN_NUMBER}}-{{FEATURE_ISSUE}}`, never `--force` and never
  to any other branch.
- No secrets in the code or the commit messages; never commit a `.env` file.
- Do not touch METIS: no UI, no API, no database. Wave G spends nothing on METIS's ledger.
- **Your cost is reported separately from METIS spend.** It is not in `token_usages`; never add
  it to the run's METIS totals.

**Scratch files go in `{{SCRATCH_DIR}}/wave-g/` only.** Wave G needs no screenshots. A fix
verdict other than not-exercised needs a step id, though, so for each one keep one image (the
`go test` output, say) in `.playwright-mcp/walkthrough-706-run{{RUN_NUMBER}}/wave-g/` and append
one line to `steps.jsonl` with `wave` `"G"`, `phase` `"G"` and `chapter` `"Implement the plan"`
(schema: the skill, section 7).

## Return

1. **Score** — exactly this table, every row filled:

   | Measure | Value |
   |---|---|
   | Builds | yes / no / not reached (`go build ./...`) |
   | Tests pass | yes / no / not reached, with failing package names (`go test ./...`) |
   | New tests written | count |
   | Tasks needing correction | N of M, each with its reason (below) |
   | Diff vs reference change set | files P/R (tp/fp/fn); functions P/R (tp/fp/fn) |
   | Agent cost | your own tokens and dollars, **separate from METIS spend** |
   | Wall time | minutes |

2. **Tasks needing correction** — one line each: task id | what was wrong | what you did.
3. **Branch and commit** — `walkthrough/run-{{RUN_NUMBER}}-{{FEATURE_ISSUE}}`, the head SHA,
   and the output of `git remote get-url origin`.
4. **`run.json` `buildProof`** — the score as the skill's section 7 shape, ready to paste:
   `{ "issue": {{FEATURE_ISSUE}}, "branch": "…", "commit": "…", "builds": true, "testsPass": false,
   "tasksTotal": 0, "tasksCorrected": 0, "files": { "tp": 0, "fp": 0, "fn": 0 },
   "functions": { "tp": 0, "fp": 0, "fn": 0 }, "agentCostUsd": 0, "wallMinutes": 0 }`
   (`null` for a build or test that was not reached).
5. **Fix verification** — for each fix listed above: fix | PR | confirmed / partial / regressed /
   not-exercised | evidence.
6. **`Durable finding:` lines** — anything a future run must know. Prefix each with exactly
   `Durable finding:`.
