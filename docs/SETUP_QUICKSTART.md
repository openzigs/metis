# Setup quick start: configuring METIS for best results

This page is for the operator who configures METIS for a client. It assumes the client's main
work is **impact analysis of a change described in Word FRDs and BRDs**: long, wordy documents
of up to about 40 requirements each, against repositories of under 5,000 files, with the model
reached through a Bedrock proxy on the client's side.

"Best results" does not mean "everything on". Several opt-in settings were measured and made
results worse, or made no difference. This page puts each setting in one of three groups, and
names the measurement behind each:

- **Recommended on:** a measurement shows a gain.
- **Leave as is:** a measurement shows no gain or a loss, or the default is on and nothing
  measured says to change it.
- **Experimental:** not measured. Keep it off for a client.

Every default here was checked against `server/src/lib/config/key-registry.ts` and the code it
names. The settings themselves are explained in [Operations §6.10](OPERATIONS.md#610-impact-analysis-code-and-document-settings).

> **Measured on a different path.** Every measurement cited here ran on `claude-sonnet-5-5`
> through the direct `anthropic` provider. The Bedrock proxy path (`AI_PROVIDER=bedrock-gateway`)
> uses the same model through a different client, and it has not yet been run live with these
> settings (#2589, #376). Run the checklist in [Verify your setup](#6-verify-your-setup) before
> analysts start.

## 1. Before you start

The infrastructure is covered elsewhere; this page does not repeat it.

- [EKS deployment](EKS_DEPLOYMENT.md): the cluster, the database, storage and secrets on AWS.
- [Kubernetes production checklist](K8S_PROD_CHECKLIST.md): what to confirm before go-live.
- The Helm chart in `deploy/helm/`, described in [Operations §7.4](OPERATIONS.md#74-kubernetes-deployment-helm).
- [Operations](OPERATIONS.md): backups, monitoring, key rotation and incidents.

## 2. Required settings

These are read from the server's environment at start-up. Section 7 has them as one block.

### AI provider and the proxy

| Setting | Value | Notes |
|---|---|---|
| `AI_PROVIDER` | `bedrock-gateway` | METIS's OpenAI-compatible client (`server/src/lib/ai/providers/bedrock-direct-provider.ts`). |
| `BEDROCK_GATEWAY_URL` | The proxy's base URL | The part before `/chat/completions`. Must be `https://` when `NODE_ENV=production`, and must not be a public model host (`server/src/lib/ai/config.ts`, `validateBedrockGatewayUrl`). |
| `BEDROCK_ALLOWED_HOSTS` | The proxy's host name | Recommended: when set, any other host is refused. |
| `BEDROCK_GATEWAY_API_KEY` | The proxy's key | A secret. Store it in the vault (Settings → Configuration) or the environment, never in a file in the repository. |
| `BEDROCK_MODEL` | The Sonnet 5.5 id the proxy serves | The built-in default is `us.anthropic.claude-sonnet-5`, which is Sonnet 5, not 5.5 (`server/src/lib/ai/config.ts`). Ask the proxy's owner for the exact id. `AI_MODEL`, if set, wins over it. |

### Tell METIS the model's size: `AI_MODEL_CATALOG_OVERRIDES`

The model catalog has no Sonnet 5.5 entry for `bedrock-gateway`
(`server/src/lib/ai/model-catalog.ts` lists Haiku 4.5, Sonnet 5, Fable 5 and Opus 4.8 there).
For a model it does not know, METIS assumes a context window of 32,768 tokens
(`DEFAULT_CONTEXT_WINDOW_FALLBACK` in `server/src/lib/analysis/context-watermark.ts`). Two things
then shrink without warning:

- the Thorough code pass's working memory, which is capped at half the window: 16,384 tokens
  instead of the 64,000 it was measured with (`resolveExploreTranscriptTokens` in
  `server/src/lib/analysis/code-pass-variant.ts`);
- the document reader, which reads in more, smaller pieces when the window is small
  (`server/src/lib/document-reader/reader.ts`).

Set the window to the one the catalog gives Sonnet 5.5 on the native provider (1,000,000), with
your exact model id. The key is `provider:model id`, matched exactly:

```bash
AI_MODEL_CATALOG_OVERRIDES={"bedrock-gateway:<your Sonnet 5.5 id>":{"contextWindow":1000000}}
```

If the proxy serves a smaller window, use that number.

### Prices: `MODEL_PRICES` (only if needed)

METIS prices every Claude id by its family, whatever the spelling: a Bedrock id containing
`claude-sonnet-5-5` is priced as Sonnet 5.5, at Bedrock's Regional rate (1.1× the list price)
for a `us.`/`eu.`/`apac.` profile or a bare `anthropic.` id (`claudeFamilyRate` in
`server/src/lib/finops/provider-rates.ts`). You need a `MODEL_PRICES` entry only when the id
does not name the model, for example an application inference-profile ARN or a proxy alias such
as `sonnet-prod`, or to apply the client's negotiated price. Without a price, usage reads
**Unpriced**, never $0, and the code pass's dollar limit falls back to its token budget alone.

```bash
MODEL_PRICES={"sonnet-prod": {"inputPerMTok": 2.2, "outputPerMTok": 11}}
```

The verify checklist below confirms the price took.

### Embeddings

Leave `EMBED_MODEL` and `EMBED_BACKEND` unset. The default, `Alibaba-NLP/gte-modernbert-base`
run in the server, scored nDCG@10 0.402 on requirement-to-code retrieval against 0.246 for the
model it replaced (#788, the comment above `EMBED_MODEL` in `.env.example`). It runs in the
server, so no document text goes to an embedding service. To use another backend, see
[Embedding backends](EMBEDDINGS_BACKENDS.md); changing it later needs a reindex.

### Database

Postgres for a client deployment: `DATABASE_URL=postgresql://…` and
`DATABASE_PROVIDER=postgresql`. SQLite is for a single machine.

### Sign-in and secrets

- `NODE_ENV=production`. With it, the server refuses to start on mock sign-in
  (`server/src/lib/auth/providers.ts`).
- `AUTH_MODE=ldap` with the `AUTH_LDAP_*` settings, or single sign-on (SAML or OIDC), configured
  through the admin API or the `AUTH_OIDC_*` settings in `.env.example`.
- `JWT_SECRET` (at least 32 bytes, `openssl rand -hex 32`) and `VAULT_MASTER_KEY`
  (`openssl rand -base64 32`). The server refuses to start without either in production.

### Storage

Keep these three on a persistent volume. A repository whose copy is missing on the server
always runs the Fast code pass, so losing `REPO_CLONE_DIR` silently costs the Thorough gain.

| Setting | Default | Holds |
|---|---|---|
| `UPLOAD_DIR` | `data/uploads` | Uploaded FRDs and BRDs |
| `LANCEDB_PATH` | `data/lancedb` | The search index |
| `REPO_CLONE_DIR` | `<server>/data/repo-clones` | Copies of the repositories |

Set `REPO_ALLOWED_HOSTS` and `DB_ALLOWED_HOSTS` to the client's Git and database hosts. Empty
allows any host.

## 3. Analysis settings, sorted

All of these are **tunables**: they can be changed on **Settings → Configuration → Runtime
tunables** and apply to the next analysis, with no restart. Section 7 sets the recommended ones
from the environment.

How the work flows matters for what each setting touches. **Requirements Analysis** reads the
FRD (the document reader) and its code agent checks each requirement against the code (the
code pass). **Impact Analysis** of those requirements then lists the files to edit, and puts the
files the code agent cited first. So the code pass settings improve impact analysis by way of
the analysis run before it.

### Recommended on

| Setting | Set to | Default | Evidence | Cost and time |
|---|---|---|---|---|
| `ANALYSIS_DOCUMENT_READER` | `true` | off | #2255 (`docs/DOCUMENT_UNDERSTANDING_BASELINE.md`): requirement recall 0.97 to 1.00 against 0.86 to 0.94 for the default whole-document read, precision 0.95 to 0.98 against 1.00, and it reads a 60 KB document the default cannot. Impact Analysis of a document then makes one change per requirement, not one per paragraph (#2231). | $0.66 to $1.12 and 3.5 to 7 minutes a document, against $0.10 to $0.19 and 1 to 1.5 minutes. Off by default only for that cost. |
| `ANALYSIS_CODE_EXPLORATION` | `explore` (Thorough) | `explore` | A21 (#2568, `eval-data/README.md`, "Production explore (A21)"): Recall@5 0.66 to 0.84 (+0.18, 95% CI [0.04, 0.34]) on Miniflux, edit precision not lower; no change on the fixture portfolio (#2587). | 1.55× the cost and 1.35× the time of Fast on a five-requirement analysis ($0.57 against $0.37; 216 s against 160 s). |
| `IMPACT_AGENT_SEEDS` | `true` | on | A7 (#1818, #1823): Recall@5 +0.256 on 39 held-out items (p < 0.001); table precision within 0.03 of its control. | None: it reuses the code agent's stored citations, no model call. |
| `IMPACT_LLM_EDIT_RERANK` | `true` | off | A13 (#1798, `docs/IMPACT_ANALYSIS_LLM_STAGES.md`): Recall@5 +0.166 [0.09, 0.25] pooled over 39 held-out items (p < 0.001), table precision held (0.531 against 0.511), no position bias. It met its bar to be turned on; it was held off only until #1762 showed the analyst the new order, and #1762 has shipped. The markdown export still lists files by depth, not in this order. | About $0.02 per requirement and repository; about 6 s per requirement (12 s across three repositories). |

### Sized for your documents (a limit, not a measurement)

| Setting | Set to | Default | Why |
|---|---|---|---|
| `ANALYSIS_AGENTIC_MAX_TURNS_CAP` | `100` | `60` | Arithmetic, not a measurement. A pass gets 2 steps per requirement, at least 10, at most the cap (`resolveAgenticMaxTurns`, `server/src/lib/analysis/agentic-pass-context.ts`). At 40 requirements the default gives 60 steps, 1.5 each: one search each, not a search and a read. A cap of 100 gives those 40 requirements 80 steps, and covers documents of up to 50. More steps do not raise the spend limits. |

The token budget (`ANALYSIS_AGENT_TOKEN_BUDGET`, 100,000) may bind on a 40-requirement pass. This
is a projection, not a measurement: the live five-requirement Thorough pass used 22,452 tokens
(A21), and the same rate for 40 requirements would be about 180,000. Leave it at the default,
and check the first large analysis (section 6). If its code pass stopped on the token budget,
the analyst can click **Continue with a larger budget**, which doubles it; if that is routine,
raise the budget.

### Leave as is: measured, and no gain or a loss

| Setting | Default | Evidence |
|---|---|---|
| `IMPACT_DEMOTE_STALE_CITATIONS` | off | A7SD against A7S (#1915, #1939): Recall@5 −0.097 [−0.17, −0.03] (p = 0.004) and MRR −0.255 after the code changed. Off for that reason. |
| `IMPACT_REQUEST_EDIT_RANKING` | off | A11 (#1776): Recall@5 0.52 to 0.46 on Miniflux. A12 after #1784: Recall@5 held, but on the portfolio fixture a one-repository answer kept its files in that repository on only 3 of 14 requirements. |
| `IMPACT_STORED_LINK_SEEDS` | off | A2 (#1754): about three more files per requirement, edit precision 0.17 to 0.13 (−0.038 [−0.06, −0.02]), Recall@5 unchanged. |
| `IMPACT_LLM_EDIT_VERIFY` | off | A4 (#1756): Recall@10 +0.07 and edit precision +0.02 pooled, but Recall@5, the bar for turning it on, did not rise on any run. $0.028 and 7.4 s per requirement. |
| `PORTFOLIO_GAP_PER_REPO_SEARCH` | off | #1766 after #2562 (`docs/ARCHITECTURE.md`, "Measured verdict accuracy"): verdict accuracy 0.60 with it and 0.60 without. |
| `CHAT_CODE_SEARCH_PRIMITIVES` | off | #2327: chat facts stated 85–87% against 81–84%, within run spread, at 25% more input tokens; on the localization set no metric moved and edit precision fell 0.57 to 0.51. |
| `CHAT_CODE_CONTEXT_TOOL` | off | #2412: no gain in facts stated or citation precision beyond run-to-run spread. |
| `CHAT_SEARCH_GUIDANCE` | off | #2324: facts stated unchanged, citation precision 88% to 80% and 84% to 81%, about 9,000 more input tokens a question. |
| `CHAT_RETRIEVAL_MIN_SCORE` | per embedder | #2417: calibrated per embedding model (0.52 for the default). Re-calibrate only if you change `EMBED_MODEL`. |

### Leave as is: on by default

| Setting | Default | Evidence |
|---|---|---|
| `CHAT_CODE_SEARCH_TOOLS` | on | #2243: chat facts stated 51% to 73–84%, citation precision 28% to 80–83%, about 4× the input tokens. |
| `ANALYSIS_FUSED_CODE_RETRIEVAL` | on | No A/B measurement found. On since #752; adds code-index excerpts to the analysis code agent, no model call. |
| `ANALYSIS_AFFECTED_CODE_MAPPING` | on | No A/B measurement found. Deterministic requirement-to-code mapping (#735), no model call. |
| `ANALYSIS_AFFECTED_SCHEMA_MAPPING`, `ANALYSIS_SCHEMA_IMPACT`, `ANALYSIS_SCHEMA_CONTEXT` | on | No A/B measurement found. Database-aware analysis, deterministic and read-only; a project with no database connection skips them. |
| `ANALYSIS_RECOVERY_REASONING` | `auto` | Keep `auto` for Claude models (key registry). It reaches only the `anthropic` and local providers; on `bedrock-gateway` it does nothing. |

The numeric settings next to these (`ANALYSIS_FUSED_CODE_*`, `ANALYSIS_AFFECTED_*`,
`ANALYSIS_SCHEMA_*`, `ANALYSIS_EXPLORE_READ_MAX_LINES`, `ANALYSIS_EXPLORE_TRANSCRIPT_TOKENS`, the
`*_MAX_OUTPUT_TOKENS` caps and the `PORTFOLIO_*` limits) were not tuned for a gain. Leave them.
The two explore values are what A21 was measured with. One worth knowing:
`ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES` (8) bounds how many requirements typed into **Evaluate
new requirements** get the deterministic affected-code mapping; it was not measured at 40.

### Experimental: not measured, keep off

| Setting | Default | Why |
|---|---|---|
| `ANALYSIS_ESCALATION_POLICY` (and its `ANALYSIS_ESCALATION_*` settings) | off | Sends ambiguous requirements to a deeper pass (#739). No measurement found; A21 ran with it off. |
| `CHAT_FUSED_CODE_RETRIEVAL` | off | Adds code-index excerpts to chat (#714). No measurement found. |

**Clarifying questions.** The key registry has no clarification setting, so there is nothing to
set. Settings that are not in the key registry (for example the `IMPACT_LLM_*` seeding switches
read from the environment) are not covered here; leave them unset.

## 4. Limits and what an analyst sees

| Limit | Default | When it is reached |
|---|---|---|
| Steps per code pass (`ANALYSIS_AGENTIC_*`) | 2 per requirement, 10 to 60 | The requirements the pass never searched for read **could not verify**, never a gap. The server logs "Agentic turn cap cannot fund one search per requirement". |
| Tokens per code pass (`ANALYSIS_AGENT_TOKEN_BUDGET`) | 100,000 | The pass keeps what it found; the run offers **Continue with a larger budget** once (2× tokens, steps and dollars). |
| Dollars per code pass (`ANALYSIS_CODE_PASS_MAX_USD`) | $1.00 per requirement | As for tokens; the run names the cost limit. Checked before each call, so it can go over by one call. |
| Tokens per month (`ANALYSIS_MONTHLY_TOKEN_CAP`) | 5,000,000 | New analyses are refused until the month turns. 0 turns it off. |
| A project's monthly budget | set per project | On the project's **⚙ → AI & cost**, with soft and hard thresholds; see the User guide's cost section (§32). |
| Text search (`grep_files`) | 5,000 files, 64 MB, 512 KB a file | Fixed in `server/src/lib/analysis/tools/grep-files.ts`, not settings. A capped search says how many files it searched and that more were not, never "not found". Under 5,000 files a repository is searched whole. |

A requirement marked **could not verify** is not a gap: METIS did not get far enough to say.
Use **Continue** on the run, or raise the limit that stopped it.

## 5. Before analysts start: lessons from a trial run

These come from a business-analyst walkthrough on 2026-11-16 (#2594), checked against the code.

- **Run the production build of the UI.** Deploy the `Dockerfile.ui` image, which runs
  `next build` and starts the standalone server with `NODE_ENV=production`. Never put
  analysts on `pnpm dev` (`next dev`). It shows Next.js's red issues badge, and the first visit to each page shows a
  blank "Loading..." screen while that page compiles.
- **Decide how uploads are approved.** Every uploaded document waits in the project's
  quarantine until someone approves it, an admin included (`server/src/lib/rag/quarantine.ts`).
  Until then it is not in the project's search index. An analysis that finds no approved
  document falls back to the raw text and says so on its results page ("Some content was
  analyzed from unapproved (quarantined) documents"). The setting is per project, not
  platform-wide: **⚙ Project settings → Quarantine → Auto-approve trusted sources**
  (`Project.autoApproveTrustedSources`, off by default). When it is on, every new document in
  that project is indexed at once (`shouldAutoApprove`); a single document can also be
  marked trusted on its own row. Changing it needs the project's update permission. For a
  client: turn it on in projects where only the client's own analysts upload their own FRDs
  and BRDs, so nobody waits on a review step that protects nothing. Leave it off in a project
  that takes documents from outside, so a person reads each one before the model does. It
  applies to new uploads only: a document already waiting still needs **Approve**.
- **Treat "Publish to Jira" as live.** With a Jira connection set up, **Publish to Jira** on
  the impact page creates the issues the moment it is clicked. There is no preview or
  confirmation yet (#2594), and publishing again creates duplicates (#1523). Configure Jira
  only if the client wants impact results in Jira. Tell analysts that the button posts
  straight away.
- **Add a database connection if changes touch the schema.** Without one, impact analysis
  can still infer tables from the code (MyBatis, JPA/Hibernate, Prisma, jOOQ and `.sql` files),
  but it has no live schema to check them against. The database agent's schema context is
  also skipped. Add one on the project's **Connections** tab with **Add database connector**.
  PostgreSQL, MySQL, Oracle and SQL Server are supported (`server/src/lib/connectors/db/drivers/`).
  Use a read-only database user. METIS also blocks every write statement itself. Add the
  database's host to `DB_ALLOWED_HOSTS`. See the [User guide §16](USER_GUIDE.md#16-database-connections).
- **Start from a clean instance or workspace.** Projects created while testing stay in every
  analyst's project switcher. Set up the client's projects on a fresh instance or in their own
  workspace, or archive the test projects (**⚙ Project settings → Archive**) before handing
  over.
- **What to expect, in time and cost.** These were observed on that walkthrough with Sonnet, a
  small FRD (two features) and a short BRD, Thorough mode and the document reader on. They are
  one run each, not a measurement:

  | Step | Time | Cost |
  |---|---|---|
  | Upload and indexing | about 10 s | none |
  | Requirements Analysis, Thorough code reading | about 5 minutes | about $0.72 to $0.91 a run |
  | Impact Analysis | about 3 minutes | about $0.47 |
  | Each round of clarifying questions | about 45 to 60 s | not recorded |

  A 40-requirement FRD takes longer and costs more. Section 6 step 5 records the client's own
  figures.

## 6. Verify your setup

Do this once, on a real FRD, before analysts start. These are the checks of #2589.

1. **Settings → Configuration → Runtime tunables** shows `ANALYSIS_DOCUMENT_READER` = true,
   `ANALYSIS_CODE_EXPLORATION` = explore, `ANALYSIS_AGENTIC_MAX_TURNS_CAP` = 100 and
   `IMPACT_LLM_EDIT_RERANK` = true.
2. Upload one FRD of about 40 requirements to a project whose repository has been ingested,
   and approve it in **Quarantine** unless the project auto-approves. Run **Requirements
   Analysis** on it. Then check:
   - the results page shows the document reader's coverage: what was read from every section;
   - the run's capability record reads `codePassMode: explore`; `fast` with reason
     `no-working-tree` means the repository's copy is missing on the server;
   - no pass in `codePassOutcomes` stopped at its step limit, and none stopped on the token
     budget or the cost limit;
   - the code agent's tool calls came back (the live "Reading the code" counts move).
3. Run **Impact Analysis** on those requirements: the files to edit say *Code agent* and *AI
   ranking* under **Found by**.
4. The project's **Usage** page shows a dollar cost for the runs, not **Unpriced**. If it reads
   Unpriced, add the model id to `MODEL_PRICES`.
5. Note the cost and time of the FRD run, to compare with the figures above.

## 7. Copy-paste environment block

Replace every `<…>`. The first part is required; the second sets the recommendations, which you
can also set on the Runtime tunables page instead.

```bash
# --- Required --------------------------------------------------------------
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
DATABASE_PROVIDER=postgresql
JWT_SECRET=<openssl rand -hex 32>
VAULT_MASTER_KEY=<openssl rand -base64 32>
AUTH_MODE=ldap                         # or configure SAML / OIDC
AI_PROVIDER=bedrock-gateway
BEDROCK_GATEWAY_URL=https://<proxy host>/<path before /chat/completions>
BEDROCK_ALLOWED_HOSTS=<proxy host>
BEDROCK_GATEWAY_API_KEY=<proxy key>    # or store it in the vault
BEDROCK_MODEL=<the Sonnet 5.5 id the proxy serves>
AI_MODEL_CATALOG_OVERRIDES={"bedrock-gateway:<the Sonnet 5.5 id the proxy serves>":{"contextWindow":1000000}}
# MODEL_PRICES={"<id>": {"inputPerMTok": <n>, "outputPerMTok": <n>}}   # only if the id does not name the model
UPLOAD_DIR=<persistent volume>/uploads
LANCEDB_PATH=<persistent volume>/lancedb
REPO_CLONE_DIR=<persistent volume>/repo-clones
REPO_ALLOWED_HOSTS=<git host>
DB_ALLOWED_HOSTS=<database hosts>

# --- Recommended for FRD / BRD impact analysis -----------------------------
ANALYSIS_DOCUMENT_READER=true
ANALYSIS_CODE_EXPLORATION=explore
ANALYSIS_AGENTIC_MAX_TURNS_CAP=100
IMPACT_LLM_EDIT_RERANK=true
```
