---
name: run-metis-dev
description: Launch the METIS dev stack (server + UI) locally and drive a real chat smoke through the configured AI provider. Use when asked to run/start METIS, confirm a change in the real app, or verify the local LLM (Ollama) round-trips end-to-end. Captures the Windows + post-merge gotchas (stale deps, shared build, the migration-guard spawn, mock auth).
---

# Run METIS locally + chat smoke

Verified on Windows (Git Bash + WSL) on 2026-06-21. The server is `server/`
(Express + Prisma + tsx), UI is `ui/` (Next.js). Dev DB is **SQLite**
(`DATABASE_URL=file:./dev.db`) — no Postgres needed. Server `:4000`, UI `:3000`.

## 1. Sync the workspace (do this after every pull/merge)

Stale `node_modules` / build output is the #1 cause of a server that won't boot:

```bash
pnpm install --frozen-lockfile           # catches new deps (e.g. @anthropic-ai/sdk)
pnpm --filter @metis/shared run build     # server imports @metis/shared's DIST
cd server && pnpm exec prisma migrate deploy && cd ..   # apply migrations to dev.db
```

Symptoms if you skip these: `Cannot find package '@anthropic-ai/sdk'` (skipped
install), `@metis/shared does not provide an export named 'X'` (stale shared build).

## 2. Launch (Windows: use Git Bash / WSL, NOT PowerShell Start-Process)

`Start-Process pnpm` fails (`%1 is not a valid Win32 application` — pnpm is a
`.cmd` shim). **Do NOT use `scripts/restart.ps1` in an MCP host** (e.g. a Claude
Code session): its stop-phase pattern matches `modelcontextprotocol` and kills
your session's MCP servers. Launch directly instead:

```bash
# server only (enough for the chat smoke):
pnpm --filter ./server run dev > logs/dev-server.log 2>&1 &
# or full stack:
pnpm dev    # = server + ui in parallel
```

If the server logs `Schema migration guard ... failed to spawn` on an OLD build,
the guard couldn't run `pnpm` (Windows `.cmd`, or no pnpm at all in the production
image); the guard now runs the Prisma CLI with `node` directly, no shell (#39,
`server/src/lib/db/migration-guard.ts`).
Bypass on any build with `METIS_SKIP_MIGRATE=1` once migrations are applied (§1):

```bash
METIS_SKIP_MIGRATE=1 pnpm --filter ./server run dev > logs/dev-server.log 2>&1 &
```

Wait for readiness (don't assume — the server crashes loudly on stale imports):

```bash
until curl -sf http://localhost:4000/healthz; do sleep 2; done
```

## 3. Drive a real chat (the actual proof)

`AUTH_MODE=mock` (in `.env`) accepts `admin`/`password` without a seeded user
(the `prisma db seed` / `tsx prisma/seed.ts` path is currently broken on Prisma 7).

```bash
B=http://localhost:4000
TOK=$(curl -s -XPOST $B/api/auth/login -H 'content-type: application/json' \
      -d '{"username":"admin","password":"password"}' | jq -r .data.accessToken)
SID=$(curl -s -XPOST $B/api/ai/sessions -H "authorization: Bearer $TOK" \
      -H 'content-type: application/json' -d '{}' | jq -r .data.session.id)
curl -s -XPOST $B/api/ai/chat -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one short sentence.\"}]}" \
  | jq -r .data.response.content
```

A non-empty `content` = the app round-trips through whatever `AI_PROVIDER` is set.

## 4. Local LLM (run METIS fully on-device)

`.env`: `AI_PROVIDER=local-gemma`, `LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1`,
`LOCAL_GEMMA_MODEL=gemma4:26b`, `LOCAL_GEMMA_API_KEY=ollama`. **Ollama** auto-starts
at login (`Ollama.lnk` in Startup) and serves OpenAI-compatible `/v1` on `:11434`,
auto-splitting `gemma4:26b` (17 GB) across both RTX 3060s. The first chat after boot
cold-loads the 17 GB model (~minutes), then it's resident. Switch back to cloud with
one line: `AI_PROVIDER=bedrock-gateway`. Embeddings stay on the metis-embeddings
sidecar (local-gemma is chat/stream only). The provider unit proof is
`server/tests/lib/ai/local-gemma-live.test.ts` (run with `LOCAL_GEMMA_LIVE=1`).

vLLM (Qwen3-32B-AWQ TP=2 / 14B single-card) was evaluated for #332 but is marginal
on these 12 GB cards (KV-starved ~5k ctx, slow); scripts in WSL `~/serve32.sh` /
`~/serve14.sh` if needed. Ollama is the daily driver.
