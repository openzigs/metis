# LOCAL_QUICKSTART — your first MCP tool call in 20 steps

> **Audience**: brand-new METIS contributor on a fresh clone (macOS or Ubuntu).
> **Goal**: from `git clone` to seeing a tool invocation appear in the audit log, with no out-of-band commands.
> **Time**: ≤ 10 minutes excluding image downloads.
>
> Issue [#364](https://github.com/openzigs/metis-private/issues/364) (Epic [#359](https://github.com/openzigs/metis-private/issues/359)).

If anything in this walkthrough fails, run `pnpm bootstrap:check` for a green/red prereq matrix with one-line fixes, then check the [troubleshooting appendix in USER_GUIDE.md](./USER_GUIDE.md#mcp-local-dev-troubleshooting).

---

## Prerequisites

| Tool                | Min version | Install hint                                       |
| ------------------- | ----------- | -------------------------------------------------- |
| Node.js             | 20 or 22    | `nvm use` (the repo ships an `.nvmrc`)             |
| pnpm                | 10.33.0     | `corepack enable && corepack prepare pnpm@10.33.0` |
| Docker (with daemon)| 24+         | Docker Desktop / Rancher Desktop / Colima          |
| openssl             | any         | macOS preinstalled; Linux `apt install openssl`    |

You do **not** need to manually create the `metis-mcp` Docker network — `docker compose up` does that for you (Issue [#361](https://github.com/openzigs/metis-private/issues/361)).

---

## Walkthrough

### 1. Clone and enter the repo

```bash
git clone https://github.com/openzigs/metis.git
cd metis
```

### 2. Install workspace dependencies

```bash
pnpm install
```

### 3. Run the one-command bootstrap

```bash
pnpm bootstrap
```

What this does (from `scripts/bootstrap.sh` — Issue [#362](https://github.com/openzigs/metis-private/issues/362)):

- Verifies `docker`, `openssl`, `pnpm` are present and the Docker daemon is reachable.
- Copies `.env.example` → `.env` (only if `.env` does not already exist).
- Generates the four required secrets (`JWT_SECRET`, `VAULT_MASTER_KEY`, `EMBEDDINGS_TOKEN`, `COPILOT_NATIVE_TOKEN`) via `openssl rand -hex 32`.
- Creates the `metis-mcp` Docker bridge network if absent.
- Pulls the 9 wrapper images from `ghcr.io/metis-mcps/*` (or, on pull failure, falls back to a local `images/mcp-wrappers/build.sh`).

You should see:

```
[bootstrap] preflight OK (docker, openssl, pnpm present; daemon reachable)
[bootstrap] wrote .env with freshly generated JWT_SECRET, VAULT_MASTER_KEY, EMBEDDINGS_TOKEN, COPILOT_NATIVE_TOKEN
[bootstrap] creating docker network metis-mcp
[bootstrap] pulling ghcr.io/metis-mcps/uvx-runner:1.0.0
…
[bootstrap] bootstrap complete. Next: 'pnpm bootstrap:up' or 'docker compose up'.
```

### 4. Verify your prereqs

```bash
pnpm bootstrap:check
```

Expect a green matrix:

```
metis bootstrap:check
─────────────────────────────────
✔ docker binary present
✔ docker daemon reachable
✔ metis-mcp network present
✔ wrapper images cached: 9/9
✔ .env present
✔ ports free or owned by metis: 3000 4000 5050 5432
─────────────────────────────────
0 failed, 6 passed
```

### 5. Bring up the stack

```bash
pnpm bootstrap:up
```

This runs `docker compose up -d` and tails the server until `/readyz` returns 200 (120s timeout).

> **Note on the dev image (issue #390)** — `docker-compose.yml` builds [`Dockerfile.server.dev`](../Dockerfile.server.dev) (~750 MB) which keeps the Prisma CLI + sqlite engine in the runtime so the entrypoint can run `prisma migrate deploy` + seed against the SQLite volume on first boot. The slim production image ([`Dockerfile.server`](../Dockerfile.server), ~380 MB) is used by `docker-compose.prod.yml` against Postgres. The dev compose default is SQLite — switch to Postgres with `docker compose --profile postgres up` (and set `DATABASE_URL=postgresql://metis:metis@postgres:5432/metis` in `.env`).

### 6. Confirm `/readyz`

```bash
curl -fsS http://localhost:4000/readyz
# {"status":"ok",...}
```

### 7. Open the UI

Browse to <http://localhost:3000>. You should see the METIS sign-in page.

### 8. Log in as the seeded admin

| Field    | Value      |
| -------- | ---------- |
| Username | `admin`    |
| Password | `password` |

(Mock auth — set in `.env` as `AUTH_MODE=mock`. The seed creates four mock users — `admin`, `coordinator`, `developer`, `reader` — all with password `password`. Their email addresses are `<username>@metis.local` for display only; login is by username.)

### 9. Open the admin panel

Click **Settings → MCP Servers** (or navigate directly to `/settings/mcp`). Use **Add MCP server** to open the admin registration form at `/admin/mcp` when adding a local wrapper by hand.

### 10. Click **Add MCP server**

You should see a modal/form with these fields:

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| Scope        | `global`                                       |
| Label        | `hello-mcp`                                    |
| Transport    | `stdio` (auto-selected for `docker-stdio`)     |
| Runtime      | `docker-stdio`                                 |
| Wrapper image| `ghcr.io/metis-mcps/npx-runner:1.0.0`          |
| Args         | `["@modelcontextprotocol/server-filesystem", "/workspace"]` |
| Env          | (leave empty)                                  |
| Trust        | `untrusted` (default)                          |

> **Tip**: the form's **Args** field accepts a comma-separated list — type `@modelcontextprotocol/server-filesystem, /workspace`.

The equivalent JSON registration POST (for copy/paste or API automation):

```json
POST /api/mcp
Content-Type: application/json

{
  "scope": "global",
  "label": "hello-mcp",
  "transport": "stdio",
  "runtime": "docker-stdio",
  "command": "ghcr.io/metis-mcps/npx-runner:1.0.0",
  "args": ["@modelcontextprotocol/server-filesystem", "/workspace"]
}
```

### 11. Click **Save**

The new MCP row appears with status `provisioning…` for a few seconds, then `ready`. The provisioner is spawning a sibling container under the `metis-mcp` network.

### 12. Verify the wrapper container is running

```bash
docker ps --filter "name=metis-mcp-" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

You should see one row whose name starts with `metis-mcp-` and whose image is `ghcr.io/metis-mcps/npx-runner:1.0.0`.

### 13. Open the AI chat

Navigate to **Workbench → Chat** (route `/chat`).

> **Local Docker note:** `pnpm bootstrap:up` uses the development compose stack, which mounts `/var/run/docker.sock` into the server container and includes the Docker CLI in `Dockerfile.server.dev`. That lets `runtime: docker-stdio` MCP registrations start sibling wrapper containers on the `metis-mcp` network without any extra host setup. The compose file defaults `DOCKER_API_VERSION=1.41` for older Docker Desktop daemons; override it in `.env` if your local daemon needs a different API level. Production images do not include this dev-only Docker socket wiring.

### 14. Send your first tool-using prompt

In the chat input, paste:

```
Using the hello-mcp filesystem tool, list the files in /workspace and summarise.
```

### 15. Approve the tool call when prompted

The first time the model invokes a tool from a new MCP, METIS surfaces an approval dialog (the **Tool registry + approval gate** — see ARCHITECTURE §6.4). Click **Approve once**.

### 16. Watch the response stream

The assistant should respond with a list of files in the wrapper container's `/workspace` directory (typically empty or showing the wrapper's own scaffolding).

`/workspace` is an ephemeral tmpfs mounted into each `docker-stdio` wrapper container by METIS. It exists so filesystem MCPs can start cleanly in the local Docker stack without exposing the host filesystem.

### 17. Open the audit log

Navigate to **Settings → Audit log** (or `/settings/audit`, which opens the configuration audit tab).

### 18. Confirm the tool invocation row

You should see at least one row with:

| Column | Value                                          |
| ------ | ---------------------------------------------- |
| action | `mcp.tool.invoke`                              |
| target | `hello-mcp`                                    |
| actor  | `admin@metis.local`                            |
| meta   | tool name, args hash, latency ms, exit status  |

### 19. (Optional) Stop the MCP

Back in **Settings → MCP Servers**, click the row's overflow menu → **Stop**. The wrapper container is reaped within a few seconds (`docker rm -f`).

### 20. Tear down the stack

```bash
docker compose down
# or, if you want to wipe local data too:
docker compose down -v
```

---

## Troubleshooting

If any of the steps above failed, the most likely cause is one of four things — see the [MCP local-dev troubleshooting appendix](./USER_GUIDE.md#mcp-local-dev-troubleshooting) in `USER_GUIDE.md`, which names each error message verbatim and gives the fix.

---

## What's next?

- **`docs/USER_GUIDE.md` §19** — full MCP admin guide (per-server limits, idle sweeps, image allowlists).
- **`docs/ARCHITECTURE.md` §20** — deployment topology + the wrapper-fan-out diagram.
- **`docs/OPERATIONS.md` §7.2/7.3** — production runtime tunables (`MCP_DOCKER_*`, `MCP_K8S_*`).
- **`images/mcp-wrappers/README.md`** — the 9 wrapper images and how to add your own.

---

## Appendix A — MCP server recipes

The walkthrough above registers **one** MCP (filesystem) so you can prove the
plumbing works. The recipes below are copy-paste-ready registrations for
the most common community MCPs. Pick the wrapper that matches the MCP's
runtime, then `POST /api/mcp` (or fill the **Settings → MCP Servers → Add** form).

> **Auth**: every recipe assumes you have a JWT in `$TOKEN`. Grab one with
> `curl -fsS -X POST http://localhost:4000/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"password"}' | jq -r .accessToken`.
>
> **Secrets**: never paste API tokens directly into `env`. Store them in the
> METIS vault first (`POST /api/vault/secrets` with `{ "name": "github-token", "value": "ghp_..." }`)
> then reference them as `${vault:github-token}` in the `env` map. The
> provisioner resolves these at spawn time and passes them via `-e KEY` so
> values never appear in `ps aux`.
>
> **Allowlist**: every recipe below uses `ghcr.io/metis-mcps/*` images,
> which are in the default `MCP_IMAGE_ALLOWLIST`. Custom images require an
> explicit allowlist entry — see USER_GUIDE §19.

### A.1 Filesystem (Node — `npx-runner`)

The walkthrough's MCP. Lets the model read/write a sandboxed directory.

```bash
curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "filesystem",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/npx-runner:1.0.0",
    "args": ["@modelcontextprotocol/server-filesystem", "/workspace"]
  }'
```

### A.2 GitHub (Node — `npx-runner`)

Repo browsing, issue / PR read & write. Requires a fine-grained PAT.

```bash
# 1. Store the token in the vault
curl -fsS -X POST http://localhost:4000/api/vault/secrets \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"github-token","value":"ghp_REPLACE_ME"}'

# 2. Register the MCP
curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "github",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/npx-runner:1.0.0",
    "args": ["@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${vault:github-token}" }
  }'
```

### A.3 Brave Search (Node — `npx-runner`)

Web search. Requires a free Brave API key.

```bash
curl -fsS -X POST http://localhost:4000/api/vault/secrets \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"brave-api-key","value":"BSA_REPLACE_ME"}'

curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "brave-search",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/npx-runner:1.0.0",
    "args": ["@modelcontextprotocol/server-brave-search"],
    "env": { "BRAVE_API_KEY": "${vault:brave-api-key}" }
  }'
```

### A.4 Fetch (Python — `uvx-runner`)

Lets the model fetch arbitrary HTTP URLs. No credentials.

```bash
curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "fetch",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/uvx-runner:1.0.0",
    "args": ["mcp-server-fetch"]
  }'
```

### A.5 SQLite (Python — `uvx-runner`)

Query a SQLite DB. The DB file must be inside the wrapper container — bind-mount
via `volumes` in `docker-compose.yml`, or generate a fresh one in `/data/`.

```bash
curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "sqlite",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/uvx-runner:1.0.0",
    "args": ["mcp-server-sqlite", "--db-path", "/data/metis.db"]
  }'
```

### A.6 Atlassian (Python — `uvx-runner`)

Confluence + Jira read & write. Requires a Confluence/Jira PAT.

```bash
curl -fsS -X POST http://localhost:4000/api/vault/secrets \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"atlassian-token","value":"REPLACE_ME"}'

curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "atlassian",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/uvx-runner:1.0.0",
    "args": ["mcp-atlassian"],
    "env": {
      "CONFLUENCE_URL": "https://your-org.atlassian.net/wiki",
      "JIRA_URL":       "https://your-org.atlassian.net",
      "CONFLUENCE_PERSONAL_TOKEN": "${vault:atlassian-token}",
      "JIRA_PERSONAL_TOKEN":       "${vault:atlassian-token}"
    }
  }'
```

### A.7 Playwright (Node — `npx-runner`)

Browser automation. The wrapper container needs `--shm-size=1g` and headed
Chrome — set this once via the `runtimeOverrides` map (server-side only,
admin scope).

```bash
curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "playwright",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/npx-runner:1.0.0",
    "args": ["@playwright/mcp@latest", "--browser=chromium"],
    "runtimeOverrides": { "shmSize": "1g" }
  }'
```

### A.8 JDBC / Oracle (JVM — `jbang-runner`)

Read-only SQL against any JDBC-reachable database via the
[quarkus-mcp-servers JDBC connector](https://github.com/quarkiverse/quarkus-mcp-servers).

```bash
curl -fsS -X POST http://localhost:4000/api/vault/secrets \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"oracle-password","value":"REPLACE_ME"}'

curl -fsS -X POST http://localhost:4000/api/mcp \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "scope": "global",
    "label": "oracle-readonly",
    "transport": "stdio",
    "runtime": "docker-stdio",
    "command": "ghcr.io/metis-mcps/jbang-runner:1.0.0",
    "args": [
      "jdbc@quarkiverse/quarkus-mcp-servers",
      "jdbc:oracle:thin:@db.example.com:1521/ORCL",
      "-u", "metis_ro",
      "-p", "${vault:oracle-password}"
    ]
  }'
```

### A.9 CodeGraph (METIS-internal — `code-graph-runner-sse`)

The bundled CodeGraph MCP exposes AST + derivation queries against the
indexed repos. Auto-registered on first server start under `scope: 'system'` —
no manual registration needed. Listed here for completeness; uses
`runtime: 'k8s-sse'` in production.

---

## Appendix B — Verifying every wrapper

After registering one MCP per wrapper family, sanity-check that all 9 cached
images are healthy:

```bash
pnpm bootstrap:check
# Expect: wrapper images cached: 9/9

docker ps --filter "name=metis-mcp-" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
# One row per registered MCP, status "Up N seconds"
```

If a row reports `Restarting`, tail its logs:

```bash
docker logs --tail 100 metis-mcp-<id>-<short>
```

The two most common failures are documented in
[USER_GUIDE.md → MCP local-dev troubleshooting](./USER_GUIDE.md#mcp-local-dev-troubleshooting):
missing env var (the MCP server itself fails to start) and missing wrapper
image (the registry POST 4xx-rejects with `wrapper image not present locally`).
