# 7. `graphify-out/` is untracked and the CI refresh is retired

Date: 2026-08-02
Status: Accepted
Issue: #1152 (follow-up to #1143, epic #1141)

## Context

[ADR 0004](0004-graphify-agent-navigation.md) removed graphify from agent instructions on
measured evidence, but deliberately kept `graphify-out/` tracked and said so explicitly:
deleting a 10.7 MB artifact with a CI workflow, local runner scripts and docs attached "is a
separate, larger decision and should not ride along with a documentation change." This ADR
is that decision.

#1152 proposed three options and named **option 2 — untrack `graph.json`, keep
`GRAPH_REPORT.md` tracked — "a starting hypothesis, not the decision."** The hypothesis was
that the two costs (the #916 rebase treadmill and the unscoped-`rg` hazard) are properties
of `graph.json` specifically and not of the report, so untracking the graph alone captures
most of the benefit.

**Measured against the repo, that hypothesis is half wrong**, and the half that fails is the
one the whole option was built on.

## What the measurement showed

### 1. The report churns *more* than the graph, not less

Of the last 30 `chore(graphify): refresh code graph` commits, **`GRAPH_REPORT.md` was
rewritten in 30 — `graph.json` in only 16.** The window is stable under three independent
definitions (`--grep 'refresh code graph'`, `--grep 'chore(graphify)'`, and the last 30
commits touching `graphify-out/`), all of which give 30/16.

The report changes on every single run even when the graph is byte-identical, because line 1
embeds the CI runner's absolute working directory and the build date:

```diff
-# Graph Report - /home/<runner>/actions-runner/_work/metis/metis  (2026-08-01)
+# Graph Report - /home/<runner>/actions-runner-4/_work/metis/metis  (2026-08-02)
```

(The self-hosted runner's account name is elided as `<runner>`; it is identical on both
sides and so is not what changes. What changes is the runner *number* and the date.)

The runner *number* varies with which self-hosted runner picks up the job
(`actions-runner`, `-2`, `-3`, `-4` all appear), so consecutive runs differ even on the same
day. Commit `ca9cd4cd` is exactly this: one changed line, no graph change.

The ratio understates the result, because the split is not statistical — it is exact.
Partitioning the same 30 commits by whether the report changed *beyond its line-1 header*:

| | commits |
|---|---:|
| graph changed **and** report changed beyond the header | 16 |
| graph unchanged **and** report changed in the header **only** | 14 |
| mismatch | **0** |

Zero mismatches. **The report's excess churn is purely the header**, deterministically: the
report never changes for a reason of its own, and it never fails to change. So option 2
would have removed the file that churns on 16 of 30 refreshes and kept the file that churns
on 30 of 30 — every one of the extra 14 being a one-line path-and-date rewrite. It does not
end the treadmill. It cannot: the treadmill's trigger is a tracked path that main rewrites
on every merge, and the report is that path.

### 2. The storage cost, by contrast, is essentially all `graph.json`

Scoped to `origin/main`'s own history (see the note below on why the scope has to be stated):

| | distinct blobs | raw bytes across history | current size |
|---|---:|---:|---:|
| `graph.json` | 164 | **1.70 GB** (1.58 GiB) | 11.58 MB, one line |
| `GRAPH_REPORT.md` | 192 | **10.1 MB** (9.7 MiB) | 52 KB, readable |

The report is 0.6% of the graph's historical byte cost despite having *more* revisions — a
ratio of about 168:1. And the graph is growing: main's root commit (`a6711674`, 2026-07-13)
already carried it at 9.01 MB; at `ca9cd4cd` on 2026-08-02 it is 11.58 MB — **+29% in 20
days**, at roughly 8 commits per day.

**On scope.** These counts are `origin/main` only, and that is deliberate. Counting with
`git rev-list --all` gives a much larger 433 blobs / 3.79 GB, but `--all` sweeps in this
machine's 224 local worktree branches, so it is not reproducible by anyone else and is not
what a clone pays. It also reaches a pre-rewrite root (`a337f966`, 2026-06-07, graph.json at
6.15 MB) that is **not an ancestor of `origin/main`** — main's history begins at the
2026-07-13 root. The clone-relevant figure is the remote-reachable one: 396 blobs / 3.44 GB
for the graph against 449 / 22.3 MB for the report, a ratio of ~155:1. Every scope gives the
same conclusion; only the absolute numbers move, which is exactly why the scope is named.

### 3. The `rg` hazard is purely a `graph.json` property — and it is real

This was the one part of the hypothesis that held. An unscoped repo-root search pulls the
11 MB single-line graph in as one match. It happened *during the work on this issue*: a
`grep -rn 'graphify-out'` at the repo root returned a 204 KB result that was almost entirely
one line of `graph.json`. The 52 KB readable report has no such property.

### 4. The report is not the artifact the hypothesis assumed it was

Both #1152 and ADR 0004 justified keeping the report as "a genuinely useful human-readable
codebase overview." Neither tested it. Of its 988 lines:

- **164 lines** are `[[_COMMUNITY_Community N|Community N]]` Obsidian wikilinks under
  "Community Hubs (Navigation)", pointing into a `wiki/` directory this repo does not have
  — one per community, so the two counts agree at 164.
- **~790 lines** are the Communities section: 164 entries, **every one** labelled
  `"Community N"` with **`Cohesion: 0.0`** and a node list truncated to 8 of up to 381. The
  labels and cohesion come from the LLM-aware semantic pass, which by design never runs in
  CI — so the committed report's largest section is structurally placeholders.
- That leaves roughly **30 lines** of real signal (summary counts, 10 "God Nodes").

The remaining section, "Surprising Connections (you probably didn't know these)", is worse
than empty. Its first entry claims:

```
pollUntil() --calls--> fn()  [INFERRED]
  e2e/tests/rag-hardening.spec.ts → server/tests/leader-election-postgres.integration.test.ts
```

**Both ends are purely local bindings that happen to share a generic name.** One is the
callback *parameter* `fn: () => Promise<T | null>` of `pollUntil` at
`e2e/tests/rag-hardening.spec.ts:45`; the other is `const fn = async () => {` at
`server/tests/leader-election-postgres.integration.test.ts:122`, a local const passed to
`withJobWindowLock`. Neither file references the other at all — grepping each for the
other's name, path and package returns zero matches in both directions. The edge is
fabricated from a name collision across two packages, the same defect class as the `path`
back-edge fabrication ADR 0004 documented. The section advertising insights is advertising
artifacts of name collision — and it is the *first* entry under a heading that promises
things "you probably didn't know."

### 5. The treadmill is currently dormant, and held shut by discipline alone

No non-bot commit has touched `graphify-out/` since **2026-07-18** (#914). The
`CLAUDE.md` / `docs/GRAPHIFY.md` rule is working. But it works by *asking*, and the thing it
asks people not to do is `git add -A` after a local `graphify .` — which is literally step 1
of the `code-issue` delivery workflow. The rule is a tripwire over a hole, not a filled hole.

## Decision

**Untrack the whole `graphify-out/` artifact set and retire the CI refresh.** graphify
becomes what its own docs already called it: an opt-in developer tool whose output is build
output.

1. `git rm --cached graphify-out/graph.json graphify-out/GRAPH_REPORT.md
   graphify-out/.graphify_root`, and replace the three narrow `.gitignore` entries with
   `graphify-out/`. Both halves are required — an ignore line alone cannot untrack a
   committed file, and untracking alone would leave the files showing up as untracked noise.
2. **Delete `.github/workflows/graphify-refresh.yml`.** With nothing tracked to commit, its
   only residual function would be spending ~1 minute of contended self-hosted runner time
   on most PRs to prove a tool nothing depends on still builds.
3. **Keep all local tooling**: `scripts/graphify-local.{sh,ps1}`, `scripts/graphify-ast-build.py`
   and `.graphifyignore` stay. The Python builder is shared by both local runners, so
   retiring the workflow orphans nothing, and `graphify-local.sh verify` already *is* the
   on-demand "does graphify still build?" check the CI job was performing.
4. **Drop `graphify claude install` from `pnpm bootstrap`** (`scripts/bootstrap.mjs`). This
   is the strongest single justification for the change, and it is worse than "it reverts
   ADR 0004." Run in a throwaway repo, the command writes two artifacts: a `## graphify`
   section appended to `CLAUDE.md`, and a `.claude/settings.json` `PreToolUse` hook with
   `"matcher": "Bash"` — the hook #1143 found watches the wrong tools. The injected section
   reads, verbatim:

   ```
   - If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
   - ... prefer `graphify query`, `graphify path`, or `graphify explain` over grep
   - After modifying code files in this session, run `graphify update .` to keep the
     graph current (AST-only, no API cost)
   ```

   So every `pnpm bootstrap` was injecting an instruction to run **`graphify update .`** —
   the precise command `CLAUDE.md`'s #916 rule existed to forbid — plus a pointer to
   `wiki/index.md`, which has never existed in this repo, plus `graphify path`, the one
   command with a proven fabrication defect. Bootstrap was not merely reverting ADR 0004;
   **it was arming the very treadmill the #916 rule was holding shut**, in the file that is
   reloaded into every non-Explore subagent. That is why this belongs in this PR rather than
   a follow-up: shipping the ADR without it would leave a window in which a developer
   reverts the decision by running the documented setup command.

   The CLI install itself stays: `scripts/bootstrap-check.mjs:126-129` records a missing
   `graphify` binary as a `fail`, so removing it would break `pnpm bootstrap:check`. Nothing
   else in `ensureGraphify()` changes.

   **Already-bootstrapped developers keep the injected artifacts** until they remove them.
   Both files are tracked, so it shows up as a diff rather than silently; run
   `graphify claude uninstall`, or revert the `## graphify` section in `CLAUDE.md` and the
   graphify `PreToolUse` hook in `.claude/settings.json` by hand. This repo's own copies are
   currently clean.

### Why not option 2 (untrack `graph.json` only)

Because it buys the storage win and the `rg` win but **not** the treadmill win, while
costing the same blast radius in docs and workflow. It would keep `GRAPH_REPORT.md` tracked
and CI-rewritten on 100% of merges, so `#916`'s workaround text would have to stay
load-bearing — and the artifact it preserves is 3% signal with a fabricated-edge section.
Paying option 1's coordination cost to get two of three benefits is the worst cell in the
matrix.

### Why not option 3 (status quo)

The costs are real and compounding: +29% graph growth in 20 days, a documented search hazard
that fired again during this very issue, and a rule holding the treadmill shut that
contradicts the delivery workflow's own `git add -A`.

### What this does *not* buy

**Clone size does not improve.** All 396 remote-reachable `graph.json` revisions and ~3.44 GB
of raw blob content stay in git history; a fresh clone pays the same as before. Only *future*
growth stops. Anyone expecting a smaller clone will not see one, and this ADR should not be
cited as if they would. Removing the history requires a filter-repo rewrite and force-push,
which is not proposed here.

## The #916 workaround text is now dead — deliberately

#1152 asked this explicitly. The answer is **yes, it can be deleted**, and it has been,
from both `CLAUDE.md` and `docs/GRAPHIFY.md`:

> Never run `graphify update .` or commit `graphify-out/` on a branch … on a conflict take
> main's copy (`git checkout origin/main -- graphify-out/`).

It is dead because it is no longer *possible* to violate. With the path both ignored and
untracked, `git add -A` stages nothing even when the local files have been modified —
verified directly on this branch — and there is no tracked copy on main left to conflict
with. The rule described a hazard that no longer exists; keeping it would cost CLAUDE.md
bytes on every subagent delegation to warn about an impossibility.

Worth recording that until this PR the rule was being actively *contradicted* by the repo's
own setup command: `pnpm bootstrap` appended a CLAUDE.md section telling the reader to run
`graphify update .` (decision 4 above). The rule and its counter-instruction lived in the
same file. Removing the hazard structurally is what makes both safe to delete.

The unscoped-`rg` warning is also removed, but for a weaker reason worth recording honestly:
in a fresh clone the file simply is not there, and `rg` respects `.gitignore` so it skips a
locally-built copy. It survives only for `grep -r` (which does not read `.gitignore`) in a
checkout where the developer opted in and built the graph — a self-inflicted, opt-in
surface, not a default one.

## The non-Claude consumers

`AGENTS.md` and `.github/copilot-instructions.md` are read by Codex, Cursor, Aider, Amp,
OpenCode and Copilot Chat. #1143 measured graphify against **Claude Code's** search tools
only. So this ADR splits the #1143 findings by whether they are platform-dependent — and the
head-to-head itself has two halves that do **not** transfer equally, so they get one row each
rather than being lumped together as a single "does not transfer":

| Finding | Transfers? | Action |
|---|---|---|
| *Answer quality*: graphify 2/10 vs native 10/10 | **No** — the denominator is Claude Code's own search tools | Not asserted to other platforms; neither file mentions 2/10 |
| *Token cost*: graphify ~4× more than one scoped search | **Approximately** — a `graphify query` returns much the same volume on any host, and a scoped grep's output is not wildly host-dependent | Retained as an approximation in `AGENTS.md` and `.github/copilot-instructions.md`, worded as "~4×" |
| `graphify path` prints routes that do not exist (upstream #2309) | **Yes** — a defect in graphify's own undirected traversal | `path` removed from both files |
| "~165× fewer tokens" | **Yes** — the figure is `graphify benchmark`'s, baselined on reading the whole corpus | Claim removed from both files |
| `graphify-out/` is committed and present | **Yes** — a fact about this repo | Both files now say build it first |

So both files keep pointing non-Claude assistants at the graph — that remains unmeasured on
their platforms and it is not this repo's place to assert otherwise — but they no longer
recommend a command with a proven fabrication defect, no longer quote a discredited
multiplier, and no longer imply the artifact ships in the clone. A stale pointer to
`graphify-out/wiki/index.md`, which has never existed in this repo, is also removed.

Every consumer was already guarded by an existence check ("if `graphify-out/GRAPH_REPORT.md`
exists…"), so untracking degrades them gracefully by construction rather than breaking them.

**`docs/TOKEN_OPTIMIZATION_GENERIC.md` is held to the same table.** It is an exportable,
platform-neutral playbook rather than repo guidance, so the tempting call is to leave it
alone — but the rows above say what transfers, and three of them applied to it verbatim: it
recommended `graphify path`, quoted a whole-corpus benchmark multiplier (~71×), and advised
wiring the refresh into "a commit hook / CI job so the committed graph stays current" —
the treadmill this ADR exists to abolish. Those three are corrected. What is **not** touched
is the platform-dependent half: the playbook still recommends graphify for navigation
generally, because that is the claim this ADR explicitly declines to assert off Claude Code.

## Consequences

- The #916 treadmill is structurally impossible, not merely discouraged. `CLAUDE.md` loses
  a five-line rule paid on every non-Explore subagent delegation.
- ~11 MB × ~8 commits/day of new blob growth stops. Existing history is unchanged.
- The `refresh` check disappears from PRs, freeing ~1 min of self-hosted runner per PR on a
  pool already contended enough to need an `api-docker-build` concurrency group.
- A fresh clone has no codebase overview. Given the report measured at ~3% signal with a
  fabricated "Surprising Connections" section, this is accepted as a loss of something that
  looked more valuable than it was — but it *is* a loss, and if a genuine overview is wanted
  later it should be written or generated deliberately, not recovered by re-tracking this one.
- `pnpm bootstrap` no longer silently re-injects the CLAUDE.md section and hook that ADR 0004
  removed.
