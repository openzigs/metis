# METIS

**M**aster **E**nterprise **T**ool for **I**ssue **S**ynthesis — an autonomous, multi-agent platform that turns requirements into reviewed, tested, shipped pull requests.

> **Status**: pre-1.0 and pre-release. The version is `0.1.0`, there are no tagged
> releases, and the only supported version is current `main` — see
> [`SECURITY.md`](SECURITY.md). It is used daily and covered by ~23,000 tests, but
> nothing here carries a compatibility promise yet. [`CHANGELOG.md`](CHANGELOG.md) has
> what has changed; [`docs/OPERATIONS.md`](docs/OPERATIONS.md) is the deployment runbook.

---

## What METIS Does

- **Ingest** business documents, code repos, and database schemas via a pluggable connector layer with full DNS-pinned SSRF defence.
- **Analyse** uploaded material with a multi-agent orchestrator (BA, architect, security reviewer, planner) running on Anthropic (or an Anthropic-compatible endpoint such as DeepSeek), OpenAI, Azure OpenAI, Bedrock, a local model (Ollama / vLLM / LM Studio), or any internal OpenAI-compatible gateway.
- **Synthesise** structured requirements + Given/When/Then acceptance criteria with a confidence score and full traceability back to source documents.
- **Publish** the resulting issue drafts to GitHub (cloud or Enterprise) via an idempotent, rate-limited batch publisher with native sub-issue support and dry-run preview.
- **Audit test coverage** by importing your existing test suite (CSV / Excel / DOCX / Markdown / Gherkin or via Jira, Xray, Zephyr Scale, TestRail) and getting a virtualised requirement × test-case coverage matrix, AI-generated gap suggestions, and Excel / Gherkin exports.
- **Schedule** recurring jobs (analysis re-runs, connector refresh, webhooks) on a cron-driven scheduler with priority task queue and live progress.
- **Run** safely in production with Prometheus metrics, JSON-log shipping, vault-encrypted secrets, RBAC, healthchecks, and one-command backup/restore.

---

## Quick Start

> **First MCP in 5 minutes →** see [`docs/LOCAL_QUICKSTART.md`](docs/LOCAL_QUICKSTART.md) for the full end-to-end walkthrough (clone → bootstrap → register an MCP → see a tool call land in the audit log).

```bash
# 1. Use the pinned Node version
nvm use            # or asdf install / volta pin

# 2. Install dependencies (pnpm workspaces)
pnpm install

# 3. One-command bootstrap
#    Generates .env + secrets, ensures the metis-mcp Docker network,
#    pulls the wrapper images. Idempotent.
pnpm bootstrap

# 4. Build the shared package. NOT optional — the server cannot start without it.
pnpm --filter @metis/shared build

# 5. Run the full dev stack (server + ui in parallel)
pnpm dev
#    …or bring up the full Dockerised stack and tail until /readyz=200:
#    pnpm bootstrap:up

# 6. Check the API is actually up — the UI coming up is NOT evidence that it is
curl -s localhost:4000/healthz
```

**Step 4 is the one people skip.** Without it the server dies at startup with
`ERR_MODULE_NOT_FOUND` while the UI starts perfectly and serves the landing page on
`localhost:3000` — so the stack looks healthy and is not. That is why step 6 checks the
API directly rather than trusting the page to load.

The same misdiagnosis appears later as `pnpm typecheck` reporting a missing export from
`@metis/shared`. The export is almost never missing; the build is stale. Re-run step 4.

Stuck? `pnpm bootstrap:check` prints a green/red matrix of every prerequisite the local
stack assumes, with one-line remediation hints.

### Quality gate (run before every PR)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

### Docker (full local stack: postgres + server + ui + embeddings + sql-lineage)

```bash
docker compose up
# Production overlay (with healthchecks, restart policies, /metrics gate):
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Kubernetes (Helm chart on EKS or any other cluster)

```bash
helm install metis ./deploy/helm/metis \
  -n metis --create-namespace \
  -f deploy/helm/metis/values-prod.yaml
```

The chart at [`deploy/helm/metis/`](deploy/helm/metis/) covers all four
core services plus PVCs (uploads + LanceDB), External Secrets Operator,
ALB / nginx / traefik Ingress, IRSA-wired ServiceAccount, RBAC into the
per-MCP namespace, HPA, PDB, and a deny-default NetworkPolicy. See
[`docs/EKS_DEPLOYMENT.md`](docs/EKS_DEPLOYMENT.md) for the green-field
guide and [`docs/K8S_PROD_CHECKLIST.md`](docs/K8S_PROD_CHECKLIST.md) for
the pre-traffic audit.

---

## Workspace Layout

| Path                  | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `server/`             | Express 5 + Prisma 6 + Socket.IO 4 backend                        |
| `ui/`                 | Next.js 15 + Tailwind v4 + shadcn frontend                        |
| `packages/shared/`    | Cross-cutting types, zod schemas, utilities (`@metis/shared`)     |
| `packages/ui-kit/`    | Shared shadcn-derived component primitives (`@metis/ui-kit`)      |
| `e2e/`                | Playwright end-to-end smoke suite                                 |
| `scripts/`            | Operational scripts (`backup.sh`, `restore.sh`)                   |
| `docs/`               | Architecture, user, ops, security, and dev guides                 |
| `.github/workflows/`  | CI (lint, typecheck, test, coverage, security, e2e)               |

---

## Environment Variables

See [`.env.example`](.env.example) for the full catalogue. Production-critical variables:

| Variable           | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `DATABASE_URL`     | Postgres connection string                               |
| `JWT_SECRET`       | Signing key for auth tokens                              |
| `VAULT_MASTER_KEY` | Master key for envelope-encrypted secret vault           |
| `METRICS_TOKEN`    | Bearer token gating `/metrics` (fail-closed if unset)    |
| `CORS_ORIGIN`      | Allow-listed UI origin(s)                                |
| `AI_PROVIDER`      | `bedrock-gateway` \| `local-gemma` \| `openai` \| `azure` \| `anthropic` \| `offline-stub` (`copilot-native` was removed — see [docs/MIGRATING_FROM_COPILOT.md](docs/MIGRATING_FROM_COPILOT.md)) |
| `GITHUB_TOKEN`     | PAT used for issue/PR automation in dev                  |

### AI providers

METIS speaks two wire formats — the OpenAI-compatible `/v1/chat/completions`
shape and Anthropic's Messages API — so the generative backend is swappable
with a single `AI_PROVIDER` change (full matrix:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#ai-provider-matrix)):

| Provider          | Where it runs           | Notes                                                              |
| ----------------- | ----------------------- | ----------------------------------------------------------------- |
| `bedrock-gateway` | Internal Bedrock gateway | Default cloud path; structured-output + prompt caching.           |
| `local-gemma`     | **Local / on-prem**     | Gemma via Ollama's OpenAI server. Keeps document content on-prem. Chat/stream only — embeddings stay on the existing backend. |

Switching between them is a one-line `AI_PROVIDER` change — the Bedrock path is
untouched when `local-gemma` is selected, and vice-versa.

#### Run Gemma locally (`local-gemma`)

1. **Install Ollama** (≥ 0.6) — <https://ollama.com/download>.
2. **Pull the model**: `ollama pull gemma4:12b` (~7.6 GB, multimodal, 256K context).
3. **Set the env vars** (see [`.env.example`](.env.example)):
   ```bash
   AI_PROVIDER=local-gemma
   # MUST include the /v1 suffix; only loopback/private hosts are accepted.
   LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1
   LOCAL_GEMMA_MODEL=gemma4:12b      # optional; default gemma4:12b
   LOCAL_GEMMA_API_KEY=ollama       # dummy — header required, value ignored
   ```
4. **Start the server** and verify streaming:
   ```bash
   curl -sS http://localhost:11434/v1/chat/completions \
     -H 'Authorization: Bearer ollama' -H 'Content-Type: application/json' \
     -d '{"model":"gemma4:12b","messages":[{"role":"user","content":"Say hello"}],"stream":true}'
   ```
   You should see incremental SSE `data:` frames. METIS streams analysis and
   chat output through the same endpoint.

> **Docker / Kubernetes note:** the URL validator intentionally accepts only
> `localhost` and IP literals (loopback / RFC-1918) to keep the SSRF surface
> tight — internal DNS **service names** like `http://ollama:11434/v1` are
> deliberately **not** allowed. When METIS runs in a container, point
> `LOCAL_GEMMA_BASE_URL` at a loopback or IP address instead: use host
> networking with `127.0.0.1`, or the Ollama container's/pod's IP
> (e.g. `http://10.0.0.12:11434/v1`).


---

## Docs

- 🧭 [User guide](docs/USER_GUIDE.md) — end-user feature documentation
- 🏗️ [Architecture overview](docs/ARCHITECTURE.md) — system design + module map
- �️ [Database impact analysis](docs/DATABASE_IMPACT_ANALYSIS.md) — schema blast radius, DDL suggestions, verdicts, and safety rails
- �🚀 [Operations](docs/OPERATIONS.md) — production deployment, monitoring, backup, key rotation
- 🔐 [Security](docs/SECURITY.md) — threat model, secret management, vulnerability disclosure
- 🛠️ [Development](docs/DEVELOPMENT.md) — local setup, testing conventions, contribution workflow
- 📜 [Changelog](CHANGELOG.md)

---

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the build, the
quality gate and the [CLA](CLA.md) — which exists so the copyright holder can relicense
in future, and is stated plainly there rather than buried. Conduct:
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security issues go through
[`SECURITY.md`](SECURITY.md), never a public issue.

### Notes for contributors

1. Pick up an open sub-issue from the active phase epic.
2. Branch with `feature/issue-{number}-{short-description}` (or `feature/phase-{n}-…` for phase work).
3. Run the quality gate locally before pushing.
4. Open a PR using the [PR template](.github/pull_request_template.md) — include `Closes #N` for every resolved issue.

---

## License

**[AGPL-3.0-only](LICENSE)** — copyright Zylos Labs LLC. See [`NOTICE`](NOTICE).

The practical consequence, stated plainly because it is easy to miss: METIS is normally
run as a network service, and AGPL section 13 means **anyone you offer it to over a
network is entitled to the source of the version you are running** — including any
changes you have made. Every METIS deployment answers this at `/source`.

If you are evaluating METIS for internal use, that obligation is usually easy to meet.
If you intend to offer it to others as a service, read the licence first.
