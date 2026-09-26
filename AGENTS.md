# AGENTS.md

Guidance for **any** AI coding assistant working in this repo — Codex, OpenCode,
Cursor, Gemini CLI, Aider, Amp, Claude Code, Factory Droid, Kiro, GitHub Copilot,
etc. (GitHub Copilot also reads [.github/copilot-instructions.md](.github/copilot-instructions.md);
keep the two in sync.)

METIS is a multi-package TypeScript application: `server/` (Express + Prisma +
LanceDB RAG), `ui/` (Next.js + Tailwind), shared `packages/`, and `e2e/`
(Playwright). It is **not** a config-only repo — there is real runtime code,
tests, and a build.

Models are reached through METIS's own provider layer (`server/src/lib/ai/providers/`):
`@anthropic-ai/sdk` for Anthropic and Anthropic-compatible endpoints, and an
OpenAI-compatible HTTP client for OpenAI, Azure, the Bedrock gateway and local runtimes.
METIS does **not** use the GitHub Copilot SDK (removed in #130) or the Vercel AI SDK.

## Optional: a local knowledge graph

This repo supports an opt-in [graphify](https://github.com/safishamsi/graphify)
knowledge graph. **It is not committed** — `graphify-out/` is gitignored build output
(#1152), so in a fresh clone it does not exist and there is nothing to read. Never block on
it; plain grep / file search is the baseline and is always correct.

If you want it, build it first with `scripts/graphify-local.sh build` (needs
`uv tool install graphifyy` — note the double **y** on PyPI; CLI binary is `graphify`;
Python 3.10+). Then, before a wide sweep:

1. If `graphify-out/GRAPH_REPORT.md` exists, skim it for a codebase overview. Note that its
   community labels and cohesion scores are placeholders unless you ran the LLM-aware
   semantic build.
2. For "where is X / what depends on Y" questions:
   ```bash
   graphify query "<terms>"              # token-bounded subgraph (default --budget 2000)
   graphify explain "<symbol_or_file>"   # node summary — arrows are NOT directional
   ```
   The default graph path is `graphify-out/graph.json`; pass `--graph <path>` to override.
3. **Fall back to grep / file reads** for line-level source, for anything changed since the
   build, and whenever the graph's answer is not obviously right.

> **Do not use `graphify path`.** It traverses the import graph undirected and renders
> back-edges as `-->`, so it reports dependency routes that do not exist (upstream
> [Graphify-Labs/graphify#2309](https://github.com/Graphify-Labs/graphify/issues/2309)).
> Verified on this repo: it claimed a 2-hop path between two modules with no path in either
> direction. Some `INFERRED` edges in `GRAPH_REPORT.md` are likewise name-collision
> artifacts across unrelated packages — confirm any edge against the source before relying
> on it.

The "~165× fewer tokens per structural query" figure previously quoted here has been
withdrawn: it comes from `graphify benchmark`, whose baseline is reading the entire ~409k-token
corpus, which is not how any assistant answers a structural question. Measured against one
scoped search instead, graphify cost ~4× *more* on this repo. Full detail:
[docs/decisions/0004-graphify-agent-navigation.md](docs/decisions/0004-graphify-agent-navigation.md).

## General token-reduction rules (apply on every platform)

- **Scope every search.** Point grep at `server/src`, `ui` or `packages` rather than the
  repo root. This is the single biggest lever, and it beat graph queries when measured.
- **Don't dump whole files into context** when a symbol or a few lines suffice.
  Read targeted ranges; close/forget files once they stop being relevant.
- **Batch edits** to the same file in one pass instead of many small round-trips.
- **Break large tasks into specific sub-tasks** with concrete acceptance criteria —
  vague prompts cause exploratory token burn.
- **Reuse what you already found** across the session instead of re-discovering structure.

### GitHub Copilot specifics

Copilot now meters **premium requests** (1 per prompt × the model's multiplier).
Notably, **Copilot code review costs 13 premium requests per review** (as of
2026-06-01), so automated review/re-review loops are expensive — minimize cycles
and only re-review after fixes are actually pushed. Prefer
[auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection)
so each task runs on the cheapest capable model. The Orchestrator agent already
runs Plan → Implement → Review in one session and caps review cycles for this reason.

Custom agents live in `.github/agents/*.agent.md`. Skills live in
`.github/skills/<name>/SKILL.md`. Hooks are configured in `.github/hooks/hooks.json`.

### Claude Code specifics

Claude Code reads `CLAUDE.md` at the repo root for project instructions. Custom
subagents live in `.claude/agents/*.md`. Project-level MCP servers are defined in
`.mcp.json`. Hooks are configured in `.claude/settings.json`.

**MCP servers:** Run `/mcp` in Claude Code to verify server status. Required env vars:
- `GITHUB_PERSONAL_ACCESS_TOKEN` — GitHub MCP server
- `TAVILY_API_KEY` — Tavily web-search MCP server

**Subagents:** Invoke with `@agent-<name>` (e.g., `@agent-code-issue`) or by asking
Claude to "use the code-review agent". Available agents: `code-issue`, `code-planner`,
`code-review`, `adversarial-reviewer`, `research`, `e2e-test`, `ui-vision`.

There is deliberately no Claude Code `orchestrator` — the main session orchestrates and
dispatches `code-issue` directly, one implementer per issue. Retired in #1145; see
[docs/decisions/0003-retire-the-claude-code-orchestrator-subagent.md](docs/decisions/0003-retire-the-claude-code-orchestrator-subagent.md).
The Copilot orchestrator agent described above is unaffected.

**Skills:** Skill workflows in `.github/skills/` are shared between both platforms.
Copilot agents read them at runtime. Claude Code discovers them through the committed
symlinks in `.claude/skills/` and loads one on match or on `/<name>` (#1142), so its
agents should **not** `Read` a SKILL.md by hand.

**Token reduction:** Claude Code subagents run in isolated contexts — verbose tool output
stays in the subagent's window and only the summary returns to your conversation.
Route high-volume tasks (test runs, doc fetching, codebase exploration) to subagents
to keep your main context lean. **MCP tool descriptions are loaded eagerly, not deferred**
(#1146) — scope a subagent to the servers it needs with `mcpServers:`, and note that a
`tools:` allowlist naming no `mcp__*` pattern removes every MCP tool from that subagent.

## Build / test / quality gate

```bash
pnpm install --frozen-lockfile --prod=false
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs `vitest run` (exits cleanly — never use watch mode). Do not
background processes with `&`/`nohup`; batch shell commands with `&&`.

## Repo hygiene

Do not commit root-level scratch artifacts (UI-vision / walkthrough / retest
screenshots, console logs, coverage dumps). `scripts/graphify-local.sh clean`
removes them; `.gitignore` already excludes the common patterns.
