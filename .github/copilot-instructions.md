# Project Conventions

METIS is a multi-package TypeScript **application**: `server/` (Express + Prisma + LanceDB RAG), `ui/` (Next.js + Tailwind), shared `packages/`, and `e2e/` (Playwright). The `.github/` directory additionally holds the custom Copilot **agents, skills, and hooks** that drive autonomous development workflows on this repo. The conventions below govern that `.github/` tooling; application code follows the language-scoped rules in `.github/instructions/`.

Cross-platform AI assistants (Codex, Cursor, Gemini, Aider, etc.) read [AGENTS.md](../AGENTS.md) at the repo root — keep it in sync with this file.

## graphify

`graphify-out/` is **gitignored build output and is not committed** (#1152) — in a fresh clone it does not exist, so default to normal grep / file_search and scope it to `server/src`, `ui` or `packages` rather than the repo root. Never block on the graph.

If you have built it locally (`scripts/graphify-local.sh build`), `graphify-out/GRAPH_REPORT.md` gives a codebase overview and `graphify query "<terms>"` returns a token-bounded subgraph (default `--budget 2000`). Full instructions: [graphify](https://github.com/safishamsi/graphify).

**Do not use `graphify path`** — it traverses the import graph undirected and prints dependency routes that do not exist (upstream [Graphify-Labs/graphify#2309](https://github.com/Graphify-Labs/graphify/issues/2309)). Treat `INFERRED` edges as unverified; some are name collisions across unrelated packages. The "~165× fewer tokens" figure once quoted here is withdrawn — its baseline was reading the whole 409k-token corpus, and against one scoped search graphify measured ~4× *more* expensive ([ADR 0004](../docs/decisions/0004-graphify-agent-navigation.md)).

**The graphify CLI is still installed by `pnpm bootstrap`** (via `uv tool install graphifyy`) — only the graph *output* is uncommitted. If you see `graphify: command not found`, run `pnpm bootstrap` or `uv tool install graphifyy` directly.

## Token discipline

Copilot meters **premium requests** (1 per prompt × the model's multiplier), and Copilot
code review costs **13 premium requests per review**. To keep cost down: prefer graphify
queries over wide sweeps, delegate high-volume work (test runs, doc fetches, exploration)
to subagents so verbose output stays out of the main context, pick the cheapest capable
model per task ([auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection)),
and minimize review/re-review cycles.

## File Types

The following describe the agent-authoring tooling under `.github/`:

- **Agents** (`.github/agents/*.agent.md`): YAML frontmatter + Markdown system prompts defining AI personas with tool restrictions and handoffs.
- **Skills** (`.github/skills/<name>/SKILL.md`): Step-by-step workflow instructions read by agents at runtime.
- **Instructions** (`.github/instructions/*.instructions.md`): File-pattern-scoped coding conventions.
- **Hooks** (`.github/hooks/`): Event-triggered scripts for session lifecycle events.

## Writing Guidelines

- Keep agent instructions concise and actionable. Agents should know exactly what to do without ambiguity.
- Use `#tool:<tool-name>` syntax when referencing tools in agent/skill bodies.
- MCP server wildcards in `tools:` arrays use the server label from `mcp.json` in lowercase: `github/*`, not `mcp_github_*`.
- Built-in tools use their exact name: `edit`, `execute`, `read`, `search`, `todo`, `web`, `browser`, `vscode`, `agent`.
- Skills are passive — they define workflows but don't restrict tools. Agents read skills via `read_file`.
- Every agent should reference its corresponding skill file path so the agent knows where to find detailed instructions.

## Frontmatter Standards

Agent files use YAML frontmatter with these fields:
- `name`: Display name in the agent picker
- `description`: Brief description shown as placeholder text
- `tools`: Array of tool/server wildcards the agent can access
- `agents`: Array of subagent names this agent can invoke
- `handoffs`: Array of transition buttons to other agents
- `argument-hint`: Optional hint text for the chat input

## Naming Conventions

- Agent files: `kebab-case.agent.md`
- Skill directories: `kebab-case/SKILL.md`
- Instruction files: `kebab-case.instructions.md`
