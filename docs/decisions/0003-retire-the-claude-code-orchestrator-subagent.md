# ADR 0003 — Retire the Claude Code `orchestrator` subagent

- **Status:** Accepted
- **Date:** 2026-07-29
- **Resolves:** GitHub #1145 (sub-issue D of epic #1141)
- **Scope:** `.claude/agents/orchestrator.md` only. The **Copilot** orchestrator
  (`.github/agents/orchestrator.agent.md`) is explicitly out of scope — epic #1141
  rules out rewriting the `.github/` layer, and the failure mode below is specific
  to how Claude Code subagents take turns.

## Context

`.claude/agents/orchestrator.md` existed to drive PLAN → IMPLEMENT → REVIEW by
delegating each phase to other subagents. Issue #1145 opened on the observation that
it was being *routed around*: in the July 2026 session that shipped 15 issues, the
user asked for "orchestrator and code-issue" and the main session dispatched
`code-issue` agents directly instead.

The issue rightly warned that "the main session did it instead" is **not** proof the
orchestrator is bad — only that a competent alternative exists. So the question this
ADR had to answer was narrower: **does the orchestrator win in any situation the
alternative does not cover?**

## Evidence

All figures are counted from `.github/hooks/logs/subagent.log`, which appends one
line per `SubagentStart` / `SubagentStop` with the started subagent's `agent_type`
(see `.github/hooks/scripts/subagent-log.mjs`). Period: 2026-06-17 → 2026-07-29.

### 1. It was not unused — it was the second most-invoked agent

| agent | starts | stops | first | last |
| --- | ---: | ---: | --- | --- |
| `code-issue` | 361 | 335 | 2026-06-17 | 2026-07-29 |
| **`orchestrator`** | **177** | **169** | **2026-06-17** | **2026-07-22** |
| `code-review` | 134 | 132 | 2026-06-17 | 2026-07-22 |
| `Explore` | 96 | 96 | 2026-06-17 | 2026-07-28 |
| `ui-vision` | 45 | 42 | 2026-06-18 | 2026-07-29 |
| `general-purpose` | 33 | 27 | 2026-06-17 | 2026-07-28 |
| `code-planner` | 26 | 25 | 2026-06-17 | 2026-07-22 |
| `research` | 17 | 17 | 2026-06-28 | 2026-07-18 |
| `e2e-test` | 9 | 9 | 2026-06-17 | 2026-06-22 |

(The `claude-security:*` agents — 715 / 90 / 1 starts — are a third-party plugin
from a single 2026-07-24/25 scan and are excluded from comparison. `Code Issue`,
14 starts, is a display-name variant of `code-issue`.)

So the premise "measurably unused" is **false**. Of 17 distinct agent types it ranks
second, and it was used steadily for five weeks.

### 2. It really did delegate

Restricting to the 95 paired runs shorter than 4h (longer windows are unreliable —
see Caveats):

- **80%** (76/95) spawned at least one worker subagent inside their window
- **77%** (73/95) spawned one within 20 minutes of starting
- median bounded run: 44 minutes

It was not a no-op wrapper. The dispatch step worked.

### 3. It stopped dead, while the work did not

Zero `orchestrator` invocations after **2026-07-22T14:43:36Z**. In the seven days
that followed, the same log records **46 `code-issue`** starts, plus `ui-vision`,
`Explore` and `general-purpose` runs. Throughput did not fall; orchestrator use went
to zero. That is abandonment, not neglect.

### 4. All 8 of its unterminated runs fall in its final 15 hours

8 of 177 starts never logged a `Stop`, and every one lands between
2026-07-21T23:46Z and 2026-07-22T14:41Z — the last day it was ever used. For
contrast, `code-issue`'s 26 unterminated starts are all on 2026-07-27/28/29, i.e.
recent and plausibly still running. The orchestrator's cluster is a week old and
is not still running.

### 5. The failure is structural, not situational

This is the decisive finding, and it comes from the operational note preserved in
full below. The orchestrator has `tools: Agent, Read, Bash, Glob, Grep, WebFetch,
WebSearch` — **no `Edit` or `Write`**. Its only productive action is to delegate.
And a Claude Code subagent's turn *ends* when it stops producing tool calls; nothing
resumes it. So it delegates, comes to rest, and its 9-step workflow — steps 4 through
9, including the security audit, review, fix and re-review cycles — never runs unless
a human nudges it with `SendMessage`.

Recorded, measured: on a 2-issue pipeline (epic #475 follow-ups #508/#509) it stalled
**three times in a row**, and one nudge produced a `code-issue` child that created an
empty branch with zero commits.

## Decision

**Retire** `.claude/agents/orchestrator.md`. Record **main-session orchestration** as
the pattern: the main session coordinates and dispatches `code-issue` agents
directly, one implementer per issue.

### Why not Keep

Keeping requires documenting *when to prefer it*, and the evidence supports no such
situation. Its own recorded history is five weeks of use ending in a stall cluster.

### Why not Narrow

Narrowing meant rewriting its `description` to claim the **unattended /
fire-and-forget** case — the strongest argument in its favour, and the one #1145 asked
to take seriously. The evidence inverts it. The documented fix for the stall is to
re-nudge the agent by hand, and **unattended is exactly the case where nobody is there
to nudge.** The orchestrator fails hardest in the scenario it was supposed to own.

Meanwhile that scenario is already covered: `code-issue` is autonomous end-to-end —
it opens its own PR, watches CI, and squash-merges. Unattended single-issue work needs
no wrapper. Writing an unattended-specialist `description` would have made
auto-delegation route work *toward* the failure, since `description` is what drives
auto-delegation.

### Why not fix it instead

Out of scope for epic #1141 ("changing what the agents do"), but worth recording: the
fix is not a prompt change. A subagent that ends its turn is finished; there is no
scheduler to wake it for step 5. Sequencing across long-running children needs an
actor that gets resumed — which is what the main session is. This is also where the
wider ecosystem has landed: **the main session orchestrates; subagents are workers**,
with Agent Teams as the escalation when workers must talk to each other.

## Consequences

- `.claude/agents/orchestrator.md` is deleted; `@agent-orchestrator` no longer resolves
  in Claude Code, and the agent is no longer offered for auto-delegation.
- `CLAUDE.md`'s agent table and `AGENTS.md`'s Claude subagent list drop the row.
- The Copilot orchestrator is untouched and still referenced by `AGENTS.md`'s
  "GitHub Copilot specifics" section.
- The operational note is preserved twice: below, and as a durable agent memory at
  `.claude/agent-memory/code-issue/feedback_main-session-orchestrates.md`.

### Caveats on the measurements

- Start/stop pairing is FIFO within an agent type. Concurrent runs of the same agent
  therefore get mis-paired, which is why unrestricted durations are meaningless
  (a p90 of 47h reflects sessions left open, not real runtimes). Only the under-4h
  cohort is quoted, and only for delegation rate.
- A missing `SubagentStop` can also mean the session was interrupted or quit, so
  finding 4 is corroborating, not conclusive, on its own.
- The log is a single developer's local history. It is evidence about how this repo
  is actually worked, not a general benchmark.

## The preserved operational note

Verbatim from the session memory that led to the bypass (originally
`orchestrator-delegation-stall-no-redispatch`), kept here because that store is not
version-controlled:

> When the `orchestrator` agent comes to rest immediately after delegating to a
> `code-issue` child (low tool-count, ~1 min, its message says "launched the
> subagent, waiting"), do NOT conclude the child failed and dispatch a second
> implementer — even if `git worktree list` / `git branch` / `gh pr list` all show
> nothing yet.
>
> **Why:** the `code-issue` child often works **directly in the main working tree**
> (no isolated git worktree, branch created later), so right after dispatch there is
> no worktree/branch/PR to observe — yet it IS running. Re-dispatching a second
> `code-issue` on the same issue makes two agents edit the same files in the same
> tree → "file modified since read" clobber war, transient broken-test states, a
> branch switched out from under the main tree, and ~10 min of wasted work. This
> happened on #423 (epic #406).
>
> **Update (epic #475 follow-ups #508/#509):** the stall is not a one-off — the
> `orchestrator` ends its turn after EVERY delegation and never resumes coordination
> (it has no Edit/Write tools, so it can only delegate, then rests). On a 2-issue
> pipeline it stalled 3× in a row: dispatched an Explore child → rested; resumed via
> `SendMessage` → dispatched a `code-issue` child that created an EMPTY branch
> (`feature/issue-508-...`, zero commits) → rested again. Re-nudging is whack-a-mole.
> **Fix that worked:** stop using the orchestrator as the driver — the main loop
> BECOMES the coordinator and dispatches `code-issue` agents directly, one issue at a
> time, waiting for each to self-merge (code-issue is autonomous: it opens its own PR,
> watches CI, and squash-merges).

The part that outlives the orchestrator itself is the collision rule: **one
implementer per issue, and a quiet child is not a dead child.** That still applies to
main-session dispatch, and is why `code-issue` agents now run in isolated worktrees.
