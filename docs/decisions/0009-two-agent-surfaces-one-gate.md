# 9. `.github/agents/` is a live Copilot surface, kept and gated — not generated, not deleted

Date: 2026-08-07
Status: Accepted
Issue: #1282 (relates to #1145, #1146, #1162, #1163, #1168, #1180, #1187, #1277)

## Context

METIS carries **two** agent-definition directories:

| Directory | Files | Read by |
|-----------|-------|---------|
| `.claude/agents/*.md` | 7 | Claude Code |
| `.github/agents/*.agent.md` | 8 | GitHub Copilot |

`pnpm agents:verify` read **only the first**. `grep -n "github/agents\|\.agent\.md"` across
`scripts/lib/agent-frontmatter-core.mjs` and `scripts/verify-agent-frontmatter.mjs` returned
nothing. So every rule the gate enforces — `Skill` in `tools:` (#1162), no uncallable
`Glob`/`Grep` (#1168), no `mcp__*` instruction to a no-MCP agent (#1180), the memory-store
rule (#1163), panel worktree isolation (#1277) — was enforced on one of two surfaces.

The consequence was measurable, not theoretical. Last commit touching `.claude/agents/` was
`54aa37e9` (2026-08-06); `.github/agents/` was `01b129f3` (2026-08-02).
`.claude/agents/adversarial-reviewer.md` carried #1277's own-worktree language three times;
`.github/agents/adversarial-reviewer.agent.md` carried it **zero** times.

## Who actually consumes `.github/agents/`

Established by grep, not by inference from the filename.

**No code in this repository reads it as an agent surface.** The only in-repo reader of that
path is the *product's* library importer — `server/src/lib/library/import.ts` walks
`{LIBRARY_AUTO_DISCOVER_ROOT}/.github/skills` and `/.github/agents` of **a user's** workspace
at boot. `LIBRARY_AUTO_DISCOVER_ROOT` is blank in `.env.example` and set nowhere else, and
that feature is about importing *someone else's* definitions into METIS's library. It is not
this repo consuming its own agents. `@github/copilot-sdk` (`server/package.json`) is the
runtime METIS calls *out* to for inference; it does not load repository agent files. No
workflow under `.github/workflows/` references the directory.

**The consumer is external: GitHub's own Copilot runtime.** `.github/agents/` is GitHub's
documented convention for [custom agents](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents) —
read by the Copilot coding agent, Copilot CLI, VS Code and Visual Studio, with org-level
definitions in `{org}/.github`. Nothing in this repository can observe that read, which is
exactly why the directory drifted for four days without anyone noticing: **it has no local
failure mode.** A stale `.claude/agents/` file breaks a session someone is sitting in front
of; a stale `.github/agents/` file breaks a Copilot session in a browser tab that never
reports back here.

`.github/copilot-instructions.md`, `AGENTS.md` and seven skills reference `.agent.md` paths,
so the directory is also load-bearing *documentation* regardless of runtime.

## Options considered

**A. Delete the directory as legacy.** Rejected: it is a live GitHub convention with live
in-repo references, and #1282 was filed *because* a Copilot session reading a stale file
misbehaves — which presupposes the sessions happen.

**B. Generate one surface from the other.** Rejected on three counts, each individually
fatal:

1. **The frontmatter schemas are disjoint.** Copilot uses a Title-Case `name`, a YAML
   block-sequence `tools:` (`execute`, `vscode`, `github/*`, `context7/*`), `agents:` and
   `handoffs:`. Claude Code uses a kebab-case `name`, a comma-separated `tools:`,
   `disallowedTools:`, `model:` and `memory:`. Neither is derivable from the other.
2. **The two surfaces have opposite MCP truth, and a gate enforces the opposition.** A
   Claude Code subagent declaring a `tools:` allowlist has *zero* MCP tools (#1146), and
   `agents:verify` **fails** an `mcp__*` instruction addressed to one (#1180). Most Copilot
   agents here hold `github/*` and `context7/*` and are correctly instructed to use them —
   six of the eight do; `adversarial-reviewer.agent.md` deliberately holds none, which is
   itself a per-agent decision a generator would have to encode. A generator would have to
   either strip Copilot's MCP flow or inject text the existing gate rejects.
3. **The rosters legitimately differ.** `orchestrator` is Copilot-only *by decision*:
   [ADR 0003](0003-retire-the-claude-code-orchestrator-subagent.md) retired the Claude Code
   orchestrator because a Claude Code subagent's turn ends when it stops emitting tool calls,
   and states the Copilot orchestrator "is a different runtime and is untouched." A generator
   would have to special-case it, i.e. reintroduce the hand-maintenance it was meant to end.

**C. Keep both, and gate what is actually shared.** Chosen.

## Decision

`.github/agents/` stays, and `pnpm agents:verify` reads it.

The gate asserts the invariants that are **runtime-independent**, and only those:

- **Frontmatter validity** — a closed fence, a `name` whose slug matches the filename, a
  `description` that is present, over the 40-character floor, and not silently ` #`-truncated
  by YAML (the #1142 defect, one parser, both surfaces).
- **The reference graph resolves** — every name in `agents:` and every `handoffs[].agent`
  must name a `.github/agents/<slug>.agent.md` that exists. This is #1146's exact class: an
  agent was deleted and a dangling reference to it survived in another agent's body. Six
  such edges exist today and nothing checked them.
- **Roster parity, with justified exemptions.** A name present in one directory and absent
  from the other must carry an explicit marker in the file that *does* exist:

  ```
  <!-- surface: copilot-only — <reason citing #NNNN or docs/decisions/... -->
  <!-- surface: claude-only  — <reason citing #NNNN or docs/decisions/... -->
  ```

  A missing marker, a marker naming the wrong surface, a marker with no issue/ADR citation,
  and a **stale** marker (one on a file whose twin does exist) are all failures. The last of
  those is deliberate: #1187's lesson is that a duplicated instruction hides a half-migration,
  so an exemption has to expire on its own when the condition ends.

### What the gate deliberately does **not** assert

**Prose parity between twins.** The bodies are legitimately different documents for
different runtimes — `research` is 233 Copilot lines against 69 Claude ones, and the MCP
point above means they must say different things. A textual-similarity check would either
be trivially satisfiable or unsatisfiable, and this repository has shipped fifteen gates
that could not fail (#1215, #1249, #1270, #1277). A gate nobody can satisfy is the mirror
of one that never fires.

So the honest boundary is: **roster and reference-graph drift is mechanically caught;
semantic drift is not.** The residual risk is real and is stated here rather than papered
over — a Copilot twin can still go stale in its *content*, as `adversarial-reviewer.agent.md`
did. What changed is that adding, removing or renaming an agent on either surface now fails
CI, which is the drift that compounds.

## Consequences

- `orchestrator.agent.md` is **kept and annotated**, not deleted — ADR 0003 scoped the
  Copilot runtime out, and deleting it here would decide something that ADR declined to.
  It carries the `copilot-only` marker, a retirement note pointing at ADR 0003, and its false
  CI paragraph is corrected: it claimed "Only `api` and `ui` jobs appear (no CodeQL)" when
  the PR surface today is twelve checks. **The claim had four copies, and it took two
  adversarial rounds to find them all** — which is the finding, not a footnote. Round one
  caught that pointing the orchestrator at `.github/skills/code-review/SKILL.md` merely
  relocated the falsehood into a document asserting the same thing, and that
  `.github/agents/code-issue.agent.md` held a third. Round two caught a fourth in
  `.github/skills/code-issue/SKILL.md`, whose entire "CI & CodeQL Verification" step gated
  handoff on `CodeQL` and `Analyze` jobs that cannot run: `.github/workflows/codeql.yml`
  does not exist. Fixing one copy at a time found three; only a census
  (`grep -rniE "every job|all checks|jobs? (appear|show)|CodeQL"` over
  `.github/skills`, `.github/agents`, `.claude/agents`, `AGENTS.md`, `CLAUDE.md`) found the
  set. All four now name the full list *and* say to trust `gh pr checks` over any written
  one, because the twelve will drift too — which is the only instruction here with a
  shelf life longer than a month.
- `.github/agents/adversarial-reviewer.agent.md` gains the half of #1277 that transfers.
  **Not** one checkout per voter: this repository can verify no such isolation in the
  Copilot runtime, and claiming one would be inventing a capability. What it gains is the
  *reason* isolation exists — so the file now states plainly that the mutation proof is
  unavailable there and must not be attempted, and that a lens needing one should report
  that limit in `notes`. The measurement rule **is** runtime-independent and is ported in
  full: quote from `git show <tip-sha>:<path>`, never from `HEAD`, which in any
  detached-from-baseline checkout hands the voter the pre-change file.
- Adding an agent to either directory now requires adding it to the other, or writing down
  why not.
