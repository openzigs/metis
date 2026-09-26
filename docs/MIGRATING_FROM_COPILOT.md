# Migrating from `copilot-native`

GitHub Copilot support was removed from METIS in epic #130 (#149, #150, #151). This page is
for deployments that used it: what stops working, what METIS does instead of guessing, and
what to change.

## Why it was removed

Since 1 June 2026 GitHub Copilot bills per token at each model's published API rate, so
routing through a Copilot subscription no longer saves money. The SDK also had no
structured output, shipped its own built-in file and shell tools that METIS neither used
nor controlled (a server-side coding agent outside METIS's approval gate), and needed a
sidecar container. Everything METIS relied on it for — sessions, compaction, tool calls,
approvals, agents and skills — now runs on METIS's own code for every provider (epic #125).

## What happens on upgrade

METIS never silently swaps a removed provider for another one. On most deployments the
"other one" would be a different, paid backend nobody chose.

| Where `copilot-native` is still named | What METIS does |
|---|---|
| `AI_PROVIDER=copilot-native` in the environment | The server **refuses to start**. The log names the supported providers and this page. |
| `AI_PROVIDER` set to `copilot-native` in the runtime configuration (Admin → Settings) | The server starts, logs an error at boot, and **refuses every AI call** with the same message until you change the setting. (It cannot refuse to start: the fix is made in the running app.) The settings page no longer accepts `copilot-native`. |
| A project's AI provider override is `copilot-native` | New chat sessions in that project are refused (`409 AI_PROVIDER_RETIRED`), and the project's provider picker shows the value as "no longer supported". Choose another provider or the global default and save. |
| A chat session created on `copilot-native` | The session stays **readable** — transcript, resume and the session list all work — but it is **read-only**: sending a message, streaming, compacting, forking or queuing an async message answers `409 AI_SESSION_PROVIDER_RETIRED`, and the chat page shows a notice and disables the composer. Start a new chat. |
| `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_API_KEY` / `COPILOT_MODEL` with `AI_PROVIDER=openai` or `azure`, and the new name unset | The server refuses to start and names each rename (below). These were read as a fallback until #149. |

## What to change

1. **Pick a provider.** Set `AI_PROVIDER` to one of the supported providers and give it
   its keys. The full matrix, with wire formats and required variables, is in
   [ARCHITECTURE.md → AI provider matrix](./ARCHITECTURE.md#ai-provider-matrix).

   | If you used Copilot for… | Use |
   |---|---|
   | Claude models | `anthropic` (`ANTHROPIC_API_KEY`), or `bedrock-gateway` behind your own gateway |
   | GPT models | `openai` (`OPENAI_BASE_URL`, `OPENAI_API_KEY`) or `azure` (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`) |
   | Keeping content on-prem | `local-gemma` (Ollama / vLLM / LM Studio, `LOCAL_GEMMA_BASE_URL`) |
   | DeepSeek | `anthropic` with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` |

2. **Rename the Copilot-era variables** if you used the OpenAI/Azure fallback:

   | Was | `AI_PROVIDER=openai` | `AI_PROVIDER=azure` |
   |---|---|---|
   | `COPILOT_PROVIDER_BASE_URL` | `OPENAI_BASE_URL` | `AZURE_OPENAI_ENDPOINT` |
   | `COPILOT_PROVIDER_API_KEY` | `OPENAI_API_KEY` | `AZURE_OPENAI_API_KEY` |
   | `COPILOT_MODEL` | `AI_MODEL` | `AI_MODEL` |

   A leftover `COPILOT_MODEL=gpt-4.1` (the value `.env.example` shipped) is ignored — it is
   already the OpenAI/Azure default.

3. **Delete what nothing reads any more** (harmless if left, but misleading):
   `COPILOT_PROVIDER_TYPE`, `COPILOT_OFFLINE`, `METIS_AUTH_DIR`, and every
   `COPILOT_NATIVE_*` variable (`MODE`, `BASE_URL`, `TOKEN`, `TIMEOUT_MS`,
   `SEND_TIMEOUT_MS`, `PORT`, `HOST`, `SESSION_TTL_MS`). For Helm, remove
   `COPILOT_NATIVE_TOKEN` from your secret and `copilot:` from your values; the chart no
   longer renders a copilot deployment even with `copilot.enabled=true`.

4. **Remove the sidecar.** The `copilot` service (`--profile copilot-native`) is gone from
   `docker-compose.yml` / `docker-compose.prod.yml`, and the `metis-copilot-svc` image is no
   longer built or published. Remove any `copilot_data` volume you created.

5. **Morph `apply_diff` users only:** the Morph call used to run inside the sidecar. It now
   runs in the server: set `MORPH_APPLY_ENABLED=true` and `MORPH_API_KEY` on the **server**
   (optionally `MORPH_API_URL`, `MORPH_MODEL`, `MORPH_APPLY_TIMEOUT_MS`). Without them the
   tool falls back to a local whole-file rewrite, exactly as before.

6. **Optional cleanup on disk.** Per-session Copilot home directories lived under
   `$METIS_SESSIONS_HOME` (default `~/.metis-sessions`) and Copilot auth under
   `METIS_AUTH_DIR` (default `~/.metis`). Nothing creates or reads them now; delete them.

## What else changed

- The `ai_sessions.copilotHome` column is dropped by migration
  `20260928000000_issue149_drop_copilot_home` (SQLite and Postgres). It only ever held the
  Copilot SDK's per-session directory.
- Loaded skills reach every provider through METIS's own progressive skill loading (the
  `load_skill` tool) — they used to be copied to disk for the Copilot SDK as well.
- The sandbox client that called the sidecar's `/sandbox/exec` (`SANDBOX_MODE=sidecar`) and
  the `code_exec` tool built on it were removed. The tool was never registered, so nothing
  that ran before stops running; METIS's sandbox providers (`SANDBOX_PROVIDER`) are unchanged.
- **Unaffected:** the GitHub repository connector, publishing to GitHub (including the
  `.copilot-workspace.md` publish option), the Copilot CLI `mcp.json` import/export, the
  Spec Kit `copilot` prompt host and the ACP bridge. Those integrate METIS *with* GitHub
  Copilot as a tool on your side; none of them ran METIS on Copilot.
