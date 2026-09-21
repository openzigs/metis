---
name: adversarial-review
description: Independent verification pass that tries to DISPROVE a change another agent already implemented. Use when asked to adversarially review, red-team, attack, or double-check a diff, branch, or PR, and by default on security-, authentication-, or authorization-touching changes before merge. Dispatches three single-lens reviewers and tallies their verdicts in code outside any model; objections without a file:line citation are discarded. For an ordinary PR review, use code-review instead.
argument-hint: "[branch, PR number, or diff range] — the change to attack"
---

# Adversarial Review

## Purpose

`code-issue` implements a change and then self-reviews it. Self-review is worth something,
but it has a structural ceiling: the agent that decided an approach is correct is the worst
candidate to decide whether it is. This skill adds the step Claude Security's scan has and
METIS's development loop did not — **the agent that finds is never the agent that judges** —
and it is deliberately small: one extra step, three voters, on the changes where the cost is
justified.

## When to run it

Run after the change is complete and the local quality gate is green, **before** opening the
PR (or before pushing a fix to an open one). It is a step in `code-issue`'s workflow, not a
replacement for `code-review`, which still reviews the PR for quality, performance and
convention.

Whether a change warrants a panel is not a judgement call — it is computed:

```bash
node -e '
import("./scripts/lib/adversarial-tally-core.mjs").then(({ shouldRunAdversarialPass }) => {
  console.log(shouldRunAdversarialPass({
    changedPaths: process.argv.slice(1),
    title: process.env.PR_TITLE ?? "",
  }));
});' $(git diff --name-only origin/main...HEAD)
```

It returns `required` plus the **reasons**, so "we ran a panel because this touched a route
handler" is auditable and "we skipped it" is a claim with a basis. The signals are security
and authorization surfaces: auth modules, middleware, route handlers, permission and role
logic, identity and session handling, secrets and crypto, SSRF and sanitisation guards, rate
limiting, tenant/project scoping, and schema migrations — plus a `security` **or `auth`** label
(`area:auth` and `area:security` both count) or a title naming security work. Route handlers
count because in this repository every router is an authorization surface; epic #1051 found
five unguarded ones and baselined twenty-three more.

Paths and labels are matched as **whole words**, not substrings, so `edge-auth.ts` fires and
`AgentAuthoringWizard.tsx` does not (#1172, #1190). Do not "fix" a missed path by loosening a
pattern: measured over every tracked path, dropping the word split costs 93 false fires and
buys nothing.

Running a panel on a change that does not need one is allowed and cheap to justify. Skipping
one on a change that does need one is a gate failure — say so rather than quietly omitting it.

## The three lenses

A second generic reviewer adds nothing: asked the same question, it mostly agrees, and
agreement between two agents that reasoned the same way is not evidence. **Diversity of
question is the entire mechanism.** Each lens is a different way for a change to be wrong,
and each is grounded in a defect this project actually shipped or nearly shipped.

| Lens | The question | The failure it exists for |
|---|---|---|
| `over-blocking` | Does this refuse work it should allow? | A guard correct about the attack and wrong about the users. `workspaceScopeFilter` (#1066) would have shipped an over-blocking regression: as a Prisma clause, `{ workspaceId: null }` matches every legacy project rather than nothing. |
| `test-falsifiability` | Would a test actually fail without the fix? | A test that passes against the unfixed code buys false confidence and stops the next person looking. #1058 found two suites that could not detect an authorization hole by construction — one stubbed `requireAuth` into a pass-through, one only ever authenticated as `admin`, who bypasses the check. |
| `instruction-correctness` | Was an instruction followed that was wrong? | The issue's premise may be false. Reusing `safe-fetch` "for consistency" would have preserved the credential leak it appeared to fix; extending `AppError` as instructed would have leaked upstream dependency statuses into our own API; and an "audit ~20 routers" alarm was simply wrong, because two upstream chokepoints already covered them — proven by deleting each in turn. |

Each lens is briefed in full in `.claude/agents/adversarial-reviewer.md`. Do not paraphrase
the lens into the dispatch; name the slug and let the agent read its own instructions.

## Workflow

### 1. Decide

Compute `shouldRunAdversarialPass`. If not required, record that and move on.

### 2. Dispatch three voters in parallel

Three `adversarial-reviewer` agents, **in one message** so they run concurrently, one per
lens, **each with `isolation: "worktree"`** so no voter can read another's mutations —
`test-falsifiability` proves a test falsifiable by reverting the change in place, and the
`Agent` tool's documented use for this parameter is exactly "agents mutate files in parallel
and would otherwise conflict".

**Commit before you dispatch.** A voter can only be handed a SHA, and your uncommitted working
tree is unreachable from its own worktree — so "run the panel before the PR" does not mean
"before the commit". Commit the change first; pushing is optional, because a worktree shares the
repository's object store. This was already the rule for a different reason — a voter's
`git checkout --` needs a committed state to restore to — and the SHAs below are the second.

Each dispatch names:

- the lens slug — exactly one, from `over-blocking`, `test-falsifiability`,
  `instruction-correctness`
- **the two commit SHAs**: the tip of the change and its base. Give SHAs, not `HEAD` and not a
  branch name — see the box below, this is the part that bites. Resolve them from whatever you
  were invoked with, and never hand the invocation itself to a voter:

  | Invoked with | tip | base |
  |---|---|---|
  | the local change | `git rev-parse HEAD` | `git merge-base origin/main HEAD` |
  | a branch | `git rev-parse <branch>` | `git merge-base origin/main <branch>` |
  | a PR number | `gh pr view <N> --json headRefOid -q .headRefOid` | `gh pr view <N> --json baseRefOid -q .baseRefOid` |

- how to obtain the change: `git diff <base-sha>...<tip-sha>`
- the instruction the change was implementing: the issue number, and the epic
- that measurements going into an objection come from `git show <tip-sha>:<path>` and
  `git show <base-sha>:<path>` rather than the working tree, and that a tree is reported dirty
  only after `git status --porcelain` says so

> **An isolated worktree does NOT contain your change, so never say `HEAD` to a voter.**
> Measured on this repository: the harness creates each agent's worktree on a fresh branch
> **from `origin/main`** (`git reflog show worktree-agent-<id>` prints "Created from
> origin/main"), and `git worktree add` cannot check out a branch that is already checked out
> elsewhere — so a voter's `HEAD` is *structurally* not your branch. A voter told
> `git diff origin/main...HEAD` gets an empty diff, and one told to read a blob **at `HEAD`**
> gets the **pre-change** file and can report "the fix was never applied" in perfect good
> faith. Both non-mutating lenses on #1277's own panel did exactly that, independently, and
> cited it as blocking — so `agents:verify` now rejects that instruction outright. SHAs work
> because a worktree shares the repository's object store, so the commit is reachable whether
> or not the branch is pushed.
>
> `test-falsifiability` needs the change *in* a tree to revert it: tell it to
> `git checkout <tip-sha>` in its own worktree, which detaches HEAD and sidesteps the
> branch-already-checked-out refusal. A fresh worktree also has **no `node_modules`** and every
> `test` script is `vitest run`, so name the suite *and* say that
> `pnpm install --frozen-lockfile --prod=false` is expected — otherwise the one lens that pays
> is the one lens that cannot run.

**Why the isolation, and why only here.** On #1275 all three lenses ran against one shared
worktree while `test-falsifiability` ran a 17-word deletability sweep through it — 17
mutate/restore cycles. Two voters read that mid-flight and filed it as findings: `over-blocking`
reported the tree dirty because `"scrub"` was deleted, and `instruction-correctness` read the
vocabulary entry `audit` as `auditz`. Neither was in the diff, and **an artefact is
indistinguishable from a finding until someone checks it** — the implementer caught both, and a
less careful pass would have "fixed" a mutation that never existed. Isolation costs roughly
200–500 ms plus a checkout's disk per agent, and a **dependency install** for whichever lens
runs the suite — #1277's own estimate missed that third term, and the voter that found it could
not run vitest at all. That is worth paying **here**, where one voter writes to the tree the
other two are reading, and is **not** a default to copy into other fan-outs: three agents that
only read a checkout can share one, and should.

Give each voter the **same** dispatch apart from the lens. Do not tell a voter what to look
for beyond its lens, do not tell it what you believe the answer is, and do not tell it what
another voter said — a voter primed with an expected outcome is a voter that confirms it.

**If your dispatch restates the output format, copy the JSON contract from
`.claude/agents/adversarial-reviewer.md` verbatim. Never compose your own.** The safest
dispatch does not restate it at all — the agent already carries it — but a hand-written one
is where the vocabulary drifts. On #1169 a dispatch offered voters `blocking|major|minor`;
the tally knows only `blocking` and `advisory`, so every objection, including one the voter
rated `major`, was demoted and the panel read `ADVISORY` with exit 0. The tally now refuses
to guess and returns `INCOMPLETE` instead (#1170) — which costs you a re-run, so get the
contract right the first time. The same applies to citations: ask for
`path/to/file.ts:123`, optionally with a short trailing description, and nothing else.

**Never dispatch a voter to review a diff you wrote earlier in this session.** The whole point
is that the implementer does not judge. If the panel is being run from the same session that
implemented the change, the voters are separate agent instances with their own context; that
separation is the mechanism and must not be collapsed by pasting your own reasoning into the
dispatch.

### 3. Tally in code, not in your head

Collect the three JSON verdict blocks into a JSON array, write it to a file, and run:

```bash
pnpm review:adversarial-tally /path/to/verdicts.json
```

**Do not grade the panel yourself.** A model summarising three verdicts can launder an uncited
hunch into a blocking objection, or forget that a lens never reported. The arithmetic lives in
`scripts/lib/adversarial-tally-core.mjs` and is unit-tested, which is the same property that
makes Claude Security's panel trustworthy: the tally is outside every model.

Outcomes:

| Outcome | Meaning | Exit |
|---|---|---|
| `BLOCKED` | At least one cited, blocking objection. Fix it, then re-run the panel. | 1 |
| `ADVISORY` | Cited objections, none blocking. Fix them or answer each in the PR body. | 0 |
| `CLEAR` | All three lenses reported; none raised a cited objection. | 0 |
| `INCOMPLETE` | A lens did not report, one reported twice, **or the tally could not parse part of the input**. **Not a clean result** — re-dispatch the missing lens, or fix the malformed field and re-tally. | 1 |

A panel has **three** states, not two: objections found, no objections found, and *the
objections could not be read*. The third is folded into `INCOMPLETE` rather than given its
own name, because the response is the same — correct the input and run it again — and
`INCOMPLETE` already meant "the panel did not actually grade what it looked at".

**Read the summary line, then read `Malformed input:` before you trust anything.** The
summary line (the second line of the report) now carries both warnings itself: how many
inputs could not be parsed, and how many objections were discarded as uncited. Entries in
`Malformed input:` prefixed `!!` are the ones that forced the outcome; unprefixed entries are
notes that cost you nothing. A `CLEAR` with a non-empty `Discarded` list is not the same
result as a `CLEAR` with an empty one — a voter raised something and the tally could not act
on it.

### 4. Record the outcome in the PR body

Always, including when the panel found nothing. A "Adversarial review" section naming the
three lenses, the outcome, and — for `CLEAR` — a one-line summary of what each voter actually
checked, taken from its `notes`. A clean panel whose voters cannot say what they examined is
indistinguishable from a lazy one, which is why `notes` is required on a `SOUND` verdict.

## Why an uncited objection is discarded

Issue #1113 states the rule: *an unsupported objection is not actionable.* The tally enforces
it literally — an objection with no `path/to/file.ts:123` citation contributes nothing to the
outcome. It is still **printed**, under "Discarded", so a voter producing nothing but hunches
is visible rather than invisible.

The citation must **begin** the string; a trailing description after the line number is
accepted (`scripts/x.mjs:66 — the fs.existsSync filter`). It did not used to be: the pattern
was anchored at both ends, so on #1163 all three voters' well-evidenced objections were
discarded as *uncited* and the panel reported `CLEAR`. All three were later confirmed correct
(#1167). What is still rejected is prose that merely contains a colon and a number
(`see the router:42`), a bare path with no line, and a URL with a port — the evidence
requirement is intact, it just no longer punishes a readable citation.

This is precision-first, and that is deliberate. It is the **opposite** of the recall-first
rule epic #1107 sets for the product engine's finding verification, and the two must not be
confused. There, a dropped finding is invisible to a reader and silent loss is the expensive
failure (#1101). Here, the artifact is a diff that a human will also read, and the expensive
failure is an implementer spending an afternoon on a hunch — and then discounting the next
objection, including the real one.

## What this pass is not

- **Not a quality review.** "Consider extracting this", "naming could be clearer", "add a
  comment" are for `code-review`. A voter that emits them is diluting its own signal.
- **Not a gate on `main`.** `BLOCKED` means fix it before the PR, not that CI enforces it.
- **Not free.** Three agents reading a diff and its surrounding code is a real cost. That is
  why it is scoped to security-relevant changes, and why #1113 says plainly: if pilots keep
  finding nothing across several PRs, **delete this rather than keeping it for symmetry.**

## Honest accounting

Record every run's outcome, including the empty ones. The question this step has to answer
is whether it pays for itself, and that question cannot be answered from a record that only
kept the runs that found something.
