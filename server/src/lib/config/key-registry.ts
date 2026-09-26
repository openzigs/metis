/**
 * Single source of truth for every runtime config key the admin UI knows about.
 *
 * Each entry is classified into one of three tiers:
 *
 *   - `bootstrap`  — read from `.env` only, NEVER overrideable at runtime.
 *                     The admin UI renders these read-only and the API
 *                     rejects writes with a 400.
 *   - `secret`     — sensitive credential. Read precedence is vault → env.
 *                     Written values land in the encrypted Vault. Audit log
 *                     entries are redacted to `[REDACTED]`.
 *   - `tunable`    — non-sensitive runtime knob. Read precedence is db → env.
 *                     Written values land in `runtime_config`. Audit log
 *                     entries store the actual values.
 *
 * Every entry carries a per-key Zod schema (#256) used by `ConfigService.set`
 * to reject bad writes at the API boundary. Bootstrap entries use `z.never()`
 * so the validator throws even if a write somehow slips past the route layer.
 */

import { z } from "zod";
import {
  MCP_K8S_CPU_LIMIT_MAX_MILLI,
  MCP_K8S_MEMORY_LIMIT_MAX_MI,
  parseCpuQuantityToMilli,
  parseMemoryQuantityToMi,
  validateEgressAllowlistEntry,
} from "@metis/shared";
import { modelPricesSchema } from "../finops/model-prices-schema.js";

export type ConfigTier = "bootstrap" | "secret" | "tunable";
export type ConfigValueType = "string" | "int" | "bool" | "json" | "csv";

export interface ConfigKeyDef {
  /** Tier dictates read precedence and write target. */
  tier: ConfigTier;
  /** Native shape of the value once parsed from string storage. */
  valueType: ConfigValueType;
  /** Per-key Zod schema. `parse()` is invoked on every write attempt. */
  schema: z.ZodType<unknown>;
  /** Human-readable description shown in the admin UI. */
  description: string;
  /** When true, value is redacted in logs and audit entries. */
  sensitive: boolean;
}

// ── Re-usable schema fragments ───────────────────────────────────────────

/** RFC-1123-ish hostname (lowercase letters, digits, dots, hyphens). */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const hostnameSchema = z.string().regex(HOSTNAME_RE, "Invalid hostname");

/**
 * Comma-separated hostname list. Accepts either a string ("a.com, b.com")
 * or an already-split array, returns a deduped array of trimmed hostnames.
 */
const csvHostnameSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((raw) => {
    const parts = (Array.isArray(raw) ? raw : raw.split(","))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return Array.from(new Set(parts));
  })
  .pipe(z.array(hostnameSchema));

/** Bootstrap-tier sentinel — every write attempt fails validation. */
const neverWritable = z.never();

// ── Registry ──────────────────────────────────────────────────────────────

export const CONFIG_KEYS: Readonly<Record<string, ConfigKeyDef>> = Object.freeze({
  // ── Tier 1 — Bootstrap (read-only in UI, env-only) ─────────────────────
  DATABASE_URL: {
    tier: "bootstrap",
    valueType: "string",
    schema: neverWritable,
    description: "Primary database connection string. Restart required to change.",
    sensitive: true,
  },
  VAULT_MASTER_KEY: {
    tier: "bootstrap",
    valueType: "string",
    schema: neverWritable,
    description: "Master key used to derive vault encryption keys.",
    sensitive: true,
  },
  JWT_SECRET: {
    tier: "bootstrap",
    valueType: "string",
    schema: neverWritable,
    description: "Symmetric secret used to sign access tokens.",
    sensitive: true,
  },
  SESSION_SECRET: {
    tier: "bootstrap",
    valueType: "string",
    schema: neverWritable,
    description: "Symmetric secret used to sign session cookies.",
    sensitive: true,
  },
  PORT: {
    tier: "bootstrap",
    valueType: "int",
    schema: neverWritable,
    description: "Server listen port.",
    sensitive: false,
  },
  NODE_ENV: {
    tier: "bootstrap",
    valueType: "string",
    schema: neverWritable,
    description: "Runtime mode (development | test | production).",
    sensitive: false,
  },
  LOG_LEVEL: {
    tier: "bootstrap",
    valueType: "string",
    schema: neverWritable,
    description: "Winston log level (debug | info | warn | error).",
    sensitive: false,
  },

  // ── Tier 2 — Runtime Secrets (vault → env) ─────────────────────────────
  OPENAI_API_KEY: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description: "API key for direct OpenAI provider use.",
    sensitive: true,
  },
  AZURE_OPENAI_API_KEY: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description: "API key for Azure OpenAI Service.",
    sensitive: true,
  },
  ANTHROPIC_API_KEY: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description: "API key for Anthropic provider.",
    sensitive: true,
  },
  BEDROCK_GATEWAY_API_KEY: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description: "API key for the internal Bedrock Access Gateway.",
    sensitive: true,
  },
  LOCAL_GEMMA_API_KEY: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description:
      "Bearer token for the local Gemma (Ollama) OpenAI-compatible server. Ollama ignores the value, but the header is required; other runtimes (vLLM/LM Studio) may enforce it.",
    sensitive: true,
  },
  GITHUB_TOKEN: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description: "Default GitHub PAT used for unattended publishing.",
    sensitive: true,
  },
  GITHUB_APP_PRIVATE_KEY: {
    tier: "secret",
    valueType: "string",
    schema: z.string().min(1),
    description: "PEM-encoded private key for the METIS GitHub App.",
    sensitive: true,
  },

  // ── Tier 3 — Runtime Tunables (db → env) ───────────────────────────────
  AI_PROVIDER: {
    tier: "tunable",
    valueType: "string",
    schema: z.enum([
      "copilot-native",
      "bedrock-gateway",
      "local-gemma",
      "openai",
      "azure",
      "anthropic",
      "offline-stub",
    ]),
    description:
      "Active AI provider (copilot-native | bedrock-gateway | local-gemma | openai | azure | anthropic | offline-stub).",
    sensitive: false,
  },
  AI_DEFAULT_MODEL: {
    tier: "tunable",
    valueType: "string",
    schema: z.string().min(1).max(200),
    description: "Default model id used for new sessions.",
    sensitive: false,
  },
  AI_MODE: {
    tier: "tunable",
    valueType: "string",
    // `AI_MODE` selects the SDK adapter shape. Constrained to a known enum to
    // prevent typos from silently disabling all AI traffic. Not the same as
    // `AUTH_MODE` (mock | ldap) — clarified in the registry comment.
    schema: z.enum(["chat", "agent", "stub"]),
    description: "AI execution mode used by the SDK adapter (chat | agent | stub).",
    sensitive: false,
  },
  // ── Epic #696 / Issue #702 — native-Anthropic prompt-cache TTL ─────────
  ANTHROPIC_PROMPT_CACHE_TTL: {
    tier: "tunable",
    valueType: "string",
    schema: z.enum(["5m", "1h"]),
    description:
      "Native-Anthropic prompt-cache TTL ('5m' | '1h'; default '5m'). Sets the ttl on the cache_control breakpoints emitted by the DIRECT Anthropic provider only — Bedrock is unaffected (no 1h TTL for Sonnet 4.6 / Opus 4.6). A 1h cache WRITE costs 2× the input rate (vs 1.25× for 5m), so the break-even shifts: 1h needs ≥3 reads to beat uncached (2× write + 0.2× reads vs 3× uncached) versus 2 reads for 5m (1.25× + 0.1× vs 2×). Leave at '5m' unless a bursty flow reuses a prefix with >5-minute gaps between calls.",
    sensitive: false,
  },
  // ── #22 (PR #41 review) — whose prices an ANTHROPIC_BASE_URL endpoint bills ──
  ANTHROPIC_BASE_URL_BILLS_AS: {
    tier: "tunable",
    valueType: "string",
    schema: z.enum(["auto", "anthropic"]),
    description:
      "Whose list prices apply to the anthropic provider when ANTHROPIC_BASE_URL is set ('auto' | 'anthropic'; default 'auto'). 'auto': any host other than api.anthropic.com is treated as a different provider (e.g. DeepSeek, which serves claude-* names as its own models), so built-in Anthropic prices are not applied and only MODEL_PRICES prices its usage. 'anthropic': the endpoint is a proxy or AI gateway that relays to Anthropic and bills Anthropic's list prices (a corporate egress proxy, LiteLLM, …), so built-in Claude prices apply as if no base URL were set. Unknown models stay unpriced either way.",
    sensitive: false,
  },
  // ── #22 — administrator-configured per-model prices ───────────────────
  MODEL_PRICES: {
    tier: "tunable",
    valueType: "json",
    schema: modelPricesSchema,
    description:
      'Per-model prices, in USD per million tokens, for models METIS has no built-in price for (or to replace a built-in one). JSON object keyed by model id, or "provider:model" to price one provider only (the more specific key wins): {"deepseek-v4-pro": {"inputPerMTok": 1.32, "outputPerMTok": 3.96, "cacheReadPerMTok": 0.044}}. cacheReadPerMTok / cacheWritePerMTok are optional and default to the input price. Usage from a model with no price here and no built-in price is recorded as UNPRICED (null cost, shown separately with its token counts in the usage views) — never as $0 and never at another model\'s price. Built-in Anthropic list prices are not applied when ANTHROPIC_BASE_URL points at a non-Anthropic endpoint, so such a deployment prices only what is listed here. Applies to usage recorded after the change; existing rows keep the cost they were recorded with.',
    sensitive: false,
  },
  // ── Epic #696 / Issue #701 — claim-extraction model selection ──────────
  DOCS_GEN_CLAIM_MODEL: {
    tier: "tunable",
    valueType: "string",
    schema: z.string().min(1).max(200),
    description:
      "Cross-provider model id for docs-gen CLAIM EXTRACTION. Unset (default) keeps the per-provider Haiku default — the cost-optimal choice: claim extraction's output:input ratio (~0.47) far exceeds the 0.07 ceiling below which cached-Sonnet could ever beat uncached-Haiku, so Sonnet's 3× output premium wins regardless of cache-hit rate (see docs/OPERATIONS.md §7.5). Set to a Sonnet id (e.g. claude-sonnet-4-6 / us.anthropic.claude-sonnet-4-6) ONLY to flip claim extraction onto the cached-Sonnet path for a workload proven cheaper by #699 telemetry. Provider-specific DOCS_GEN_*_CLAIM_MODEL and DOCS_GEN_GROUNDING_MODEL take precedence. Rollback = unset.",
    sensitive: false,
  },
  // ── Issue #1226 — docs-gen OUTPUT caps (was hardcoded 8192 / 4096) ─────
  DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "OUTPUT cap (max_tokens) for one Phase-2 docs-gen SECTION synthesis call (#1226). Default 32768; was hardcoded at 8192, which silently truncated long BRD sections (the model stopped mid-answer or the gateway substituted a max_tokens placeholder) while the document was still marked ready. Clamped down to the resolved model's known output ceiling, so raising it above what the model supports can never turn a working call into a 400. Also the provider-level default for every Phase-2 call that does not set its own cap.",
    sensitive: false,
  },
  DOCS_GEN_PHASE1_CONCURRENCY: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(64),
    description:
      "#25 — how many Phase-1 module fact extractions docs-gen keeps in flight at once (1-64, default 3). A worker pool: the next module starts the moment any extraction finishes. Wall-clock time for a large project scales roughly with modules ÷ this value, so a 174-module project at ~23 s per module takes about an hour at 1 and about 22 minutes at 3. Raise it when the provider allows more parallel requests (DeepSeek documents a 500-request concurrency limit for deepseek-v4-pro); keep it low behind a gateway with request-rate or idle-timeout limits.",
    sensitive: false,
  },
  DOCS_GEN_PHASE2_CONCURRENCY: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(64),
    description:
      "#178 — how many Phase-2 batch calls of one batched docs-gen section (Business Rules, Key Workflows, Calculations, Data Model) run at once (1-64). Unset, the default depends on the provider: 1 for local-gemma (the local provider's LOCAL_GEMMA_MAX_CONCURRENCY limiter already holds requests to the server's real parallelism) 4 for the cloud providers bedrock-gateway, anthropic, openai and azure, and 1 for every other provider (copilot-native, offline-stub, any new key). The openai provider pointed at a self-hosted server — OPENAI_BASE_URL (or COPILOT_PROVIDER_BASE_URL) on a loopback host or a private IP address — also defaults to 1, because the local request limiter covers only local-gemma; a self-hosted server behind a hostname, or an anthropic / azure / gateway endpoint on the local network, is not detected, so set this value to the server's real parallelism there. A set value applies to every provider. Batch replies are always merged in plan order, so the section is the same whatever order the calls finish in — unless the section's re-split budget runs out, in which case which cut-off batch gets the last re-split depends on which reply arrives first. Raise it where the account's request and token quotas allow; lower it behind a gateway with request-rate limits.",
    sensitive: false,
  },
  DOCS_GEN_PHASE1_CHUNK_INPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1_000).max(262_144),
    description:
      "Most INPUT tokens (source code + pre-extracted formulas + mined-rule inventory) one Phase-1 docs-gen fact-extraction call reads (default 24000). Phase 1 reads every function and all module-level code of every module; a module larger than one call is read in several calls (chunks), each also sized so its estimated reply fits DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS. Converted to characters at 3.5 chars/token (laguna-s-2.1's tokenizer measured 3.66–3.95 on TypeScript). Keep it modest (≤ ~40000): local prompt processing slows sharply with length. The prompt plus the output cap must fit the served context.",
    sensitive: false,
  },
  DOCS_GEN_PHASE1_INCLUDE_TESTS: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Whether Phase-1 docs-gen fact extraction reads and mines test, spec and fixture files (default true — full coverage). When false, files matching the test-path rules are neither sent to the model nor mined, and the coverage log reports them as excluded by policy. The rules: *.test.* / *.spec.* files, test_*.py, *_test.go / *_test.py, *Test / *Tests classes (.java, .kt, .cs, .scala, .groovy; not SplitTest / AbTest / MultivariateTest, which model A/B tests) and *IT JVM integration tests; files under test, tests, __tests__, __mocks__, mocks, testing, spec, e2e, fixtures or __fixtures__ directories, C# test projects (Foo.Tests/, Foo.UnitTests/), *-fixtures / *_fixtures directories and fixture-corpus / fixture-data / fixture-files directories; testing.* and *-testing.* modules (not ab-testing, load-testing and similar features); double-extension fixtures (user.fixture.ts); test-harness.* files; and vitest / jest / playwright / karma / cypress configs. An ambiguous name — fixture.ts, harness.ts, a specs/ directory — is read as production. On onyourleft test files are about half the source, so turning this off roughly halves Phase-1 time.",
    sensitive: false,
  },
  // ── Issue #182 — repository-source RAG ingest coverage ────────────────
  REPO_SOURCE_MAX_FILES: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(1_000_000),
    description:
      "Most repository source files one connector sync embeds into the RAG index that grounds document generation and chat (#182; default 5000, was a hard-coded 200). Files are taken production code first, then configuration and data files (json, yaml, xml, gradle, properties), then test/spec/fixture files, each group in path order, so the budget is never spent on tests or config while business code waits. Every file left out is counted and logged, the connector records the ingest as partial, and document generation warns that the index is incomplete.",
    sensitive: false,
  },
  REPO_SOURCE_MAX_FILE_BYTES: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024),
    description:
      "Largest repository source file (bytes) the RAG ingest embeds (#182; default 1048576 = 1 MiB). A file up to this size is split into chunks and indexed whole — the old 64 KB limit silently skipped every larger file. A file above it is skipped, logged by path, counted and listed on the connector; it does not make the ingest partial or mark generated documents degraded (#217). The ceiling exists for generated or vendored blobs (bundles, lockfile-sized JSON), whose embedding time grows with their size.",
    sensitive: false,
  },
  REPO_SOURCE_INCLUDE_TESTS: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Whether the repository RAG ingest embeds test, spec and fixture files (#182; default true). They are always taken LAST, after production code and configuration, so they only use budget REPO_SOURCE_MAX_FILES has left. When false they are not embedded at all and are reported as excluded by policy, not as skipped. Uses the same test-path rules as DOCS_GEN_PHASE1_INCLUDE_TESTS.",
    sensitive: false,
  },
  REPO_SOURCE_INGEST_CONCURRENCY: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(8),
    description:
      "Repository source files ingested at once during a connector sync (#182; default 1, max 8). Embedding itself is serialised — the in-process model runs one forward call at a time in its worker thread, one text per call at a quantized dtype (#807) — so a second lane only overlaps each file's database and vector-store writes with the next file's embedding. Keep 1 on the default SQLite database: concurrent ingest transactions were measured colliding there and failing files. On Postgres with a remote embeddings backend (sidecar or cloud), 2-4 can shorten a large sync.",
    sensitive: false,
  },
  DOCS_GEN_REASONING_ALLOWANCE_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(0).max(393_216),
    description:
      "#25 — extra OUTPUT tokens added to every docs-gen output cap (section, facts, DB-schema prose, claim/judge) for a model that REASONS BY DEFAULT and spends that reasoning from the same max_tokens budget as the answer. Default 32768. Applies only to models documented to think by default: DeepSeek deepseek-v4-pro / deepseek-flash, and a claude-* model name sent to DeepSeek's Anthropic endpoint (ANTHROPIC_BASE_URL on deepseek.com), which serves it as one of those models. Every other model is unaffected. The section/facts caps then describe the ANSWER budget and this is the reasoning headroom on top, still clamped to the model's output ceiling. Claim extraction and the faithfulness judge are NON-streaming calls, so on the anthropic provider their request is further clamped to the Anthropic SDK's non-streaming bound (21,333 tokens, or the SDK's lower per-model limit) — they receive less than the sum. Set 0 to opt out (e.g. when thinking has been disabled upstream).",
    sensitive: false,
  },
  DOCS_GEN_PHASE1_REASONING: {
    tier: "tunable",
    valueType: "string",
    schema: z.enum(["auto", "provider-default", "off", "low", "medium", "high"]),
    description:
      "#25 — how much a Phase-1 docs-gen FACT-EXTRACTION call may reason. auto (default): low effort for a model that REASONS BY DEFAULT (DeepSeek deepseek-v4-pro / deepseek-flash, or a claude-* name sent to DeepSeek's Anthropic endpoint) and nothing for every other model, so Claude on api.anthropic.com is unchanged. provider-default: send nothing (DeepSeek then thinks at its default, high). off: thinking disabled. low / medium / high: that effort for ANY model — on Claude this turns adaptive thinking on. Phase 1 is mechanical extraction: with the #41 output budget, deepseek-v4-pro at its default spent ~19,800 output tokens and ~88 s per module, mostly reasoning. Honoured by the anthropic provider (thinking + output_config.effort; DeepSeek maps medium to high); other providers ignore it. DOCS_GEN_REASONING_ALLOWANCE_TOKENS still sizes the cap.",
    sensitive: false,
  },
  DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "OUTPUT cap (max_tokens) for one Phase-1 docs-gen FACT-EXTRACTION call (#1226). Default 8192; was hardcoded at 4096, which truncated the per-module fact blob for large modules and starved every downstream section of source facts. Clamped down to the resolved model's known output ceiling. Also the provider-level default for every Phase-1 call that does not set its own cap.",
    sensitive: false,
  },
  // ── Issue #152 — claim-extraction OUTPUT cap (was the section cap) ────
  DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "OUTPUT cap (max_tokens) for one grounding CLAIM-EXTRACTION call (#152). Default 16384; claim extraction previously reused DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS. Sections are sent in passages of about 8,000 characters, and a passage whose claim list still stops at the cap is split and asked again, so raise this only when a section is reported as having exceeded its output cap. Clamped down to the claim model's known output ceiling; an unknown (e.g. local) model defaults to 8192.",
    sensitive: false,
  },
  // ── Docs-gen fact-checking depth (fast local test runs) ───────────────
  DOCS_GEN_GROUNDING: {
    tier: "tunable",
    valueType: "string",
    schema: z.enum(["on", "sample", "off"]),
    description:
      "How much of each generated documentation section is fact-checked (claim extraction + faithfulness judge). on (default): every claim of every section — keep this for production. sample: a deterministic, spread-out sample of each section's passages (DOCS_GEN_GROUNDING_SAMPLE_RATE, at least 10 claims per section when it has that many) is decomposed and judged; the score is an estimate, the document carries a document-level grounding-sampled warning and is degraded, never ready, and every section the sample only partly covered carries its own. off: no claim extraction and no judge calls; every section carries a grounding-skipped warning, as does the document, the provenance manifest records mode off, and the document is degraded, never ready. For fast local test runs, where fact-checking can take about three times as long as writing. An unrecognised value falls back to on.",
    sensitive: false,
  },
  DOCS_GEN_GROUNDING_SAMPLE_RATE: {
    tier: "tunable",
    valueType: "string",
    schema: z.coerce.number().gt(0).max(1),
    description:
      "Share of each section's passages fact-checked when DOCS_GEN_GROUNDING=sample (0 < rate ≤ 1, default 0.25). The passages are drawn deterministically (seeded from their text) from evenly spaced parts of the section, and topped up until at least 10 claims are judged when the section has that many. Ignored in the other modes. An invalid value falls back to 0.25.",
    sensitive: false,
  },
  // ── Issue #1228 — DB-schema prose OUTPUT cap (was the inherited 4096) ───
  DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "OUTPUT cap (max_tokens) for one DB-schema TABLE-PROSE batch (#1228). Default 16384; previously no cap was passed at all, so the call inherited the provider's 4096 default and a 30-table JSON batch over a wide schema was cut mid-object — the unterminated brace failed the parser and the whole batch was discarded silently (0 of 641 tables described on a real Oracle schema). Clamped down to the resolved model's known output ceiling. Lower it only alongside DB_SCHEMA_SYNTH_BATCH_SIZE, since one batch is one JSON object and is all-or-nothing.",
    sensitive: false,
  },
  // ── Epic #712 / Issue #714 — fused code-graph retrieval in chat RAG ────
  CHAT_FUSED_CODE_RETRIEVAL: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for fused passive code-graph retrieval in chat + Spec-Kit RAG (#714). OFF by default. When on, project-scoped sessions additionally query the code graph / symbol index (HybridCodeSearch) and merge deduped symbol hits — each with a filePath:startLine-endLine locator — into the retrieved-knowledge system block (volatile tail; the byte-stable lead is untouched). When off, no code-graph query is issued and behaviour is byte-identical to today.",
    sensitive: false,
  },
  CHAT_COMPACTION_WATERMARK_PERCENT: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(10).max(95),
    description:
      "Share of the model's context window (from the model catalog) at which a chat turn first summarises its oldest turns (#138). Default 80. The summarised messages are kept in the transcript and marked compacted — never deleted. A project's contextCompactionThreshold, or CONTEXT_COMPACTION_THRESHOLD_TOKENS, caps it from above.",
    sensitive: false,
  },
  CHAT_CONTEXT_WINDOW_FALLBACK: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1024),
    description:
      "Context window (tokens) chat assumes when the model catalog does not know the model's (#138) — e.g. a local model discovery has not described yet. Default 32768: too small only compacts early, too large can overflow a small local context. Set a model's real window with AI_MODEL_CATALOG_OVERRIDES instead where you can.",
    sensitive: false,
  },
  CHAT_TOOL_RESULT_MAX_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Largest tool result (tokens, estimated) a chat turn puts in the model's context (#138). Longer results are truncated with a marker; the full result is kept in the conversation transcript. Default 2000.",
    sensitive: false,
  },
  CHAT_COMPACTION_SUMMARY_MAX_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Output cap (max_tokens) for one chat-compaction summary call (#138). Default 2048. A summary that hits the cap is kept and flagged as truncated in the transcript.",
    sensitive: false,
  },
  CHAT_FUSED_CODE_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max tokens (≈4 chars/token) the fused code-symbol block may occupy (#714). On overflow the ranked TAIL of symbol hits is truncated — RAG doc chunks are never dropped. Default 1500.",
    sensitive: false,
  },
  CHAT_FUSED_CODE_MAX_SYMBOLS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on symbol hits fetched from the code graph per fused chat request before dedupe/budget (#714). Default 12.",
    sensitive: false,
  },
  // ── Epic #725 / Issue #729 — fused code-graph retrieval in analysis ────
  ANALYSIS_FUSED_CODE_RETRIEVAL: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for fused passive code-graph retrieval in the analysis code agent (all three modes — single-shot retrieveContext, agentic seed, requirement-grounded fold) (#729, Epic #725 — parity with chat/Spec-Kit #714). ON by default (flipped on in #752 now that #750 restored the agentic/requirement-grounded modes this seeds); operators can still disable it. When on, the code agent queries the code graph / symbol index (HybridCodeSearch) and appends deduped, token-budgeted symbol chunks — each carrying filePath:startLine-endLine provenance for Epic #726 citations — after the requirements-half + source-code-half chunks. When off, no code-graph query is issued and the retrieved context is byte-identical to the pre-#729 behaviour.",
    sensitive: false,
  },
  ANALYSIS_FUSED_CODE_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max tokens (≈4 chars/token) the fused code-symbol chunks may occupy in the analysis code agent's context (#729). On overflow the ranked TAIL of symbol hits is truncated deterministically — document chunks are never dropped. Default 1500.",
    sensitive: false,
  },
  ANALYSIS_FUSED_CODE_MAX_SYMBOLS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on symbol hits fetched from the code graph per analysis retrieval before dedupe/budget (#729). Default 12.",
    sensitive: false,
  },
  // ── P0 #769 — agentic code-agent depth knobs ───────────────────────────
  ANALYSIS_AGENTIC_MAX_TURNS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max turns (LLM calls) the agentic code agent's tool loop may take per pass (#769). Default 10. Investigating many requirements over a large codebase may legitimately need more; the loop now salvages its investigation with one bounded final-answer call when the cap is hit, so raising this buys depth, not correctness.",
    sensitive: false,
  },
  ANALYSIS_AGENT_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Token budget for one agentic code-agent run, split across repos on multi-repo projects (#769). Default 100000. The bounded #769 final-answer retry may spend a small amount beyond this to serialize work already done.",
    sensitive: false,
  },
  // ── Issue #1218 — the degraded-pass retry's OUTPUT cap ─────────────────
  ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "OUTPUT cap (max_tokens) for the bounded final-answer retry the agentic code pass spends when it could not serialize its investigation, and the basis for the salvage repair's own cap (#1217/#1218). Default 16384. This is a PER-CALL output cap, never the cumulative spend budget — that is ANALYSIS_AGENT_TOKEN_BUDGET. Since #1221 it is CLAMPED to the active model's verified output ceiling (server/src/lib/ai/model-output-limits.ts), so setting it above what the model supports is warned about once at startup naming both numbers, rather than becoming a provider 400 on the degraded salvage pass. The clamp also covers the salvage repair, whose cap is this value × 1.25 and can therefore exceed it. A model absent from that table is NOT clamped by the model ceiling — it is warned about instead, because guessing a ceiling would be a fail-open — but it is still held at the Anthropic SDK's non-streaming bound of 21333 on the anthropic provider (#1257), which is a fact about the client rather than a guess about the model. A non-positive or non-numeric value is rejected at boot (the server refuses to start), not at call time.",
    sensitive: false,
  },
  // ── Issue #1223 — the SYNTHESIS call's OUTPUT cap ───────────────────────
  ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "OUTPUT cap (max_tokens) for the synthesis call that reconciles every specialist's findings into the requirement set (#1223). Default 21000. Left unset this call inherited the provider default — 16000 on anthropic — and truncated mid-JSON on most runs, because thinking tokens spend the same budget as the answer; synthesis then degraded silently to its deterministic fallback. Separate from ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS, which bounds ONE agent's findings and defaults lower. Lower this to the model's output ceiling when that ceiling is below the default, or the provider rejects the call with a 400. Since #1257 a value above 21333 is CLAMPED on the anthropic path rather than failing: the SDK refuses a non-streaming request implying over ten minutes of work, client-side, before any network call. Bedrock has no such bound. Invalid values are rejected at boot (the server refuses to start).",
    sensitive: false,
  },
  // ── Issue #773 — turn budget must be able to FUND an honest verdict ─────
  ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().nonnegative(),
    description:
      "Turns granted per requirement in an agentic code pass (#773). Default 2 (one search + one read). ANALYSIS_AGENTIC_MAX_TURNS is the floor and ANALYSIS_AGENTIC_MAX_TURNS_CAP the ceiling. Set 0 to disable scaling and use the flat floor. A pass that cannot investigate every requirement marks the ones it never reached `could-not-verify` — never a gap — so this knob buys confirmable verdicts, not just depth. Spend stays bounded by ANALYSIS_AGENT_TOKEN_BUDGET.",
    sensitive: false,
  },
  ANALYSIS_AGENTIC_MAX_TURNS_CAP: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Hard ceiling on the requirement-scaled agentic turn cap (#773). Default 60, so a very large requirement set cannot run the loop away. LOWERING THIS HAS A VERDICT CONSEQUENCE: one turn emits the final answer, so a pass can make at most (turns - 1) tool calls, and it can only confirm a gap for a requirement it actually ran a search for. Set this below the requirement count and the requirements the pass never searched for come back `could-not-verify` instead of as confirmed gaps (the server logs a warning when the cap cannot fund one search per requirement). Spend is bounded by ANALYSIS_AGENT_TOKEN_BUDGET, not by turns.",
    sensitive: false,
  },
  // ── Epic #726 / Issue #735 — deterministic requirement→code mapping ─────
  ANALYSIS_AFFECTED_CODE_MAPPING: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for the deterministic requirement→code mapping on the analysis 'Evaluate new requirements' path (#735, Epic #726). ON by default. When on and free-text new requirements are supplied, the code agent parses them into discrete candidates and reuses Impact Analysis's mapRequirementToCode + blastRadius over the project code graph, injecting the affected-code list into the gap prompt as fenced, token-budgeted context (and persisting it for the UI). When off — or with no new requirements / no code graph — it is a clean no-op and the prompt + budget are byte-identical to the pre-#735 behaviour.",
    sensitive: false,
  },
  ANALYSIS_AFFECTED_CODE_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max tokens (≈4 chars/token) the deterministic affected-code block may occupy in the analysis code agent's context (#735). On overflow the ranked TAIL of candidates/symbols is truncated deterministically. Carved OUT of the agent's token budget, never additive. Default 1500.",
    sensitive: false,
  },
  ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on requirement candidates parsed from the new-requirements text that are mapped to code per analysis run (#735). Default 8.",
    sensitive: false,
  },
  ANALYSIS_AFFECTED_CODE_MAX_SYMBOLS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on affected code symbols (direct + blast radius) retained per requirement candidate before token budgeting (#735). Default 8.",
    sensitive: false,
  },
  // ── Epic #820 Phase 1 / Issue #824 — deterministic AFFECTED SCHEMA prompt block ─
  ANALYSIS_AFFECTED_SCHEMA_MAPPING: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for the deterministic AFFECTED SCHEMA block injected into the analysis database (Sally), code, and synthesis prompts (#824, Epic #820 Phase 1). When on, the impacted code symbols are crossed into the schema graph (#823) and the affected tables/columns/routines — with their live-schema reconciliation status and a TEXT-ONLY, never-executed suggested DDL — are rendered into the prompts as fenced, token-budgeted context. When off — or with no schema edges / no impacted symbols — it is a clean no-op and the prompts are byte-identical to the pre-#824 behaviour. ON by default since #849 (the crossing is deterministic and issues no LLM calls of its own). Since Epic #852 the effective gate is the per-project `Project.databaseAwareAnalysis` setting; this key is the PLATFORM DEFAULT behind that setting's `auto` value — explicitly setting it false (env or admin UI) is the fleet-wide kill-switch and resolves `auto` projects to `auto->platform-disabled`, while a per-project explicit `on` still wins.",
    sensitive: false,
  },
  ANALYSIS_AFFECTED_SCHEMA_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max tokens (≈4 chars/token) the deterministic AFFECTED SCHEMA block may occupy in the database/code/synthesis prompts (#824). On overflow the lowest-confidence affected rows are dropped deterministically. Carved OUT of the consuming agent's token budget, never additive. Default 1200 (matches DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET in #823).",
    sensitive: false,
  },
  ANALYSIS_AFFECTED_SCHEMA_MAX_ROWS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on affected schema objects (tables/columns/routines) rendered into the AFFECTED SCHEMA block per analysis run before token budgeting (#824). Highest-confidence rows are kept. Default 8 (matches DEFAULT_AFFECTED_SCHEMA_MAX_ROWS in #823).",
    sensitive: false,
  },
  // ── Epic #820 / Issue #847 — per-requirement gap-report schema-impact section ─
  ANALYSIS_SCHEMA_IMPACT: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for the per-requirement `databaseChanges` section of the analysis gap report (#847, Epic #820). When on, the gap-report route supplies a real `loadSchemaImpact` producer that, per requirement, crosses the requirement's impacted code into the schema graph (reusing #823's `crossToSchema`) and enumerates its cross-project shared-database consumers (reusing #822's `enumerateSchemaConsumers`) — read-only, TEXT-ONLY suggested DDL, never executed. ON by default since #849 — the crossing is deterministic graph traversal with no LLM calls, and it short-circuits for projects with no schema data. Since Epic #852 the effective gate is the per-project `Project.databaseAwareAnalysis` setting; this key is the PLATFORM DEFAULT behind that setting's `auto` value — explicitly setting it false (env or admin UI) is the fleet-wide kill-switch and resolves `auto` projects to `auto->platform-disabled`, while a per-project explicit `on` still wins. When off the gap report is byte-identical to the pre-#847 shape (no `databaseChanges`).",
    sensitive: false,
  },
  ANALYSIS_SCHEMA_IMPACT_MAX_REQUIREMENTS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on how many requirements the gap-report schema-impact producer crosses per report (#847). Bounds the per-request cost of the synchronous per-requirement code→schema crossing + cross-project consumer enumeration. Default 50.",
    sensitive: false,
  },
  // ── Epic #727 / Issue #739 — requirement escalation policy ──
  ANALYSIS_ESCALATION_POLICY: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for the requirement escalation policy on the agentic analysis path (#739, Epic #727). OFF by default. When on, each extracted requirement is scored for ambiguity (deterministic text heuristics) + impact (blast-radius size, reusing #726/#735), and high scorers (score ≥ ANALYSIS_ESCALATION_SCORE_THRESHOLD, capped at ANALYSIS_ESCALATION_MAX_REQUIREMENTS) are routed to a DEEPER multi-hop agentic pass (ANALYSIS_ESCALATION_DEEP_MAX_TURNS) while the rest stay at the normal turn cap. The two passes SPLIT the existing per-run token budget proportionally, so escalation reallocates — never grows — spend. When off, the agentic pass runs with uniform depth exactly as before and nothing is persisted.",
    sensitive: false,
  },
  ANALYSIS_ESCALATION_SCORE_THRESHOLD: {
    tier: "tunable",
    valueType: "string",
    schema: z.coerce.number().min(0).max(1),
    description:
      "Combined ambiguity+impact score (0–1) at/above which a requirement is eligible for a deep multi-hop agentic pass (#739). Default 0.5. Weights are 0.5 ambiguity / 0.5 impact.",
    sensitive: false,
  },
  ANALYSIS_ESCALATION_MAX_REQUIREMENTS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().nonnegative(),
    description:
      "Upper bound on how many requirements may be escalated to a deep pass per run (#739). Bounds how much of the shared token budget is diverted to deep passes: the top-N eligible scorers are escalated, the rest stay standard. Default 3.",
    sensitive: false,
  },
  ANALYSIS_ESCALATION_DEEP_MAX_TURNS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Agentic loop turn cap for an escalated (deep) requirement pass (#739). Higher than the standard 10-turn cap so high-ambiguity/high-impact requirements get more multi-hop retrieval within their token share. Default 16.",
    sensitive: false,
  },
  ANALYSIS_ESCALATION_IMPACT_SATURATION: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Blast-radius size (# impacted code symbols) at which a requirement's impact sub-score saturates to 1.0 (#739). A requirement mapping to this many or more symbols scores maximal impact. Default 8.",
    sensitive: false,
  },
  // ── Epic #725 / Issue #732 — schema-aware context for Sally (database) ──
  ANALYSIS_SCHEMA_CONTEXT: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for schema-aware context in the analysis database agent's (Sally's) retrieveContext (#732, Epic #725). ON by default (flipped on in #752); operators can still disable it. When on, the database agent's context additionally introspects the project's primary DB connector (read-only — never DDL, never a routine body) and appends a token-budgeted schema summary (tables/entities, key columns, relationships, and where a usage classification exists, used/unreferenced tags) after the document-RAG chunks, as a synthetic `live-schema:<projectId>` chunk the model can cite. When off — or when the project has no introspectable schema — no introspection is issued and the retrieved context is byte-identical to the pre-#732 docs-only behaviour.",
    sensitive: false,
  },
  ANALYSIS_SCHEMA_CONTEXT_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max tokens (≈4 chars/token) the introspected schema summary may occupy in the analysis database agent's context (#732). On overflow the tail of tables (least-connected first) is truncated deterministically and a truncation marker is appended — document chunks are never dropped. Default 2000.",
    sensitive: false,
  },
  ANALYSIS_SCHEMA_CONTEXT_MAX_TABLES: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Upper bound on tables rendered into the analysis database agent's schema summary before the token budget is applied (#732). Guards against pathologically wide schemas. Default 60.",
    sensitive: false,
  },
  ANALYSIS_SCHEMA_CONTEXT_OVERFLOW_INDEX_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Max tokens for the name-only index of tables dropped by ANALYSIS_SCHEMA_CONTEXT_TOKEN_BUDGET. Naming the dropped tail costs ~7 tokens per table instead of ~450, and stops the database agent reporting a column as absent when it simply was not shown that table. Default 4000.",
    sensitive: false,
  },
  // ── Epic #712 / Issue #713 — agentic code-search tools in chat ─────────
  CHAT_CODE_SEARCH_TOOLS: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Master enable for agentic code-search TOOLS in chat + stream (#713). OFF by default. When on, project-scoped sessions may call search_code_graph (exact graph traversal) and search_code_symbols (hybrid BM25+vector symbol search) — offered and EXECUTED on every provider path (Copilot SDK, native-Anthropic, bedrock-direct) via the shared textual agent loop, even without loaded skills. Tool schemas render deterministically into the byte-stable prompt lead, so the flag flips the cached prefix ONCE per deploy (expected); the per-turn latency cost is one extra bounded model round-trip per executed tool call (loop capped at a few turns). When off, no tools are offered, no loop runs, and the prompt is byte-identical to today. Distinct from CHAT_FUSED_CODE_RETRIEVAL (#714), which is PASSIVE per-request retrieval into the volatile tail.",
    sensitive: false,
  },
  // ── Epic #128 — one tool runtime + enforced approval gate ─────────────
  CHAT_TOOLS: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Offer METIS and MCP tools to the model in chat and stream (#140). ON by default. Applies only to project-scoped sessions on a model the catalog marks tool-capable: the tools go as NATIVE tool definitions, only MCP servers the project may use are offered, and EVERY call passes the session's approval gate (#142) before it runs — its low/medium/high policy, its agent's tool allowlist, and a prompt to the session's owner when the policy asks for one. Off: no METIS/MCP tools are offered (the code-search tools still follow CHAT_CODE_SEARCH_TOOLS).",
    sensitive: false,
  },
  AI_TOOL_APPROVAL_TIMEOUT_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "How long a chat tool call waits for its owner to approve or deny it (#142), in ms. An unanswered approval EXPIRES and counts as a denial; the tool does not run. Default 120000.",
    sensitive: false,
  },
  LOCAL_GEMMA_BASE_URL: {
    tier: "tunable",
    valueType: "string",
    schema: z.string().url(),
    description:
      "Base URL for the local Gemma (Ollama) OpenAI-compatible server. MUST include the /v1 suffix, e.g. http://localhost:11434/v1.",
    sensitive: false,
  },
  LOCAL_GEMMA_MODEL: {
    tier: "tunable",
    valueType: "string",
    schema: z.string().min(1).max(200),
    description: "Model id streamed by the local Gemma provider (default: gemma4:12b).",
    sensitive: false,
  },
  ANALYSIS_MONTHLY_TOKEN_CAP: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description: "Hard cap on tokens consumed by analysis per calendar month.",
    sensitive: false,
  },
  ANALYSIS_AGENT_TOKEN_CAP: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description: "Hard cap on tokens consumed by a single agent run.",
    sensitive: false,
  },
  // ── Epic #1316 / issue #1321 — online (live-traffic) RAG eval ────────────
  ONLINE_EVAL_ENABLED: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Kill switch for online eval — scoring a sampled fraction of completed production runs with the RagasJudge seam. OFF by default. The scorer is a read-only observer: it adds no latency, changes no user-visible output, and a scoring failure never affects the run. Keep it OFF until a real judge lands (#1317); the only implementation today is the lexical StubRagasJudge.",
    sensitive: false,
  },
  ONLINE_EVAL_SAMPLE_RATE: {
    tier: "tunable",
    valueType: "string",
    schema: z.coerce.number().min(0).max(1),
    description:
      "Fraction of eligible completed runs scored by online eval, in [0,1]. Default 0.01 (1%). 0 disables sampling without touching ONLINE_EVAL_ENABLED.",
    sensitive: false,
  },
  ONLINE_EVAL_MONTHLY_TOKEN_BUDGET: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().nonnegative(),
    description:
      "Monthly token allowance for online-eval judge calls. SEPARATE from ANALYSIS_MONTHLY_TOKEN_CAP — online scoring must never consume the analysis allowance. Enforced as a reservation taken BEFORE each judge call. Fails closed: 0 means spend nothing, not unlimited. Default 250000.",
    sensitive: false,
  },
  ONLINE_EVAL_TOKENS_PER_SCORE: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Tokens reserved against the online-eval budget before each judge call, reconciled against the measured payload afterwards. Default 1500.",
    sensitive: false,
  },
  ONLINE_EVAL_WINDOW_SIZE: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Number of sampled runs aggregated into one online-eval window envelope in eval-results/online/. Default 20.",
    sensitive: false,
  },
  ONLINE_EVAL_DRIFT_THRESHOLD_PCT: {
    tier: "tunable",
    valueType: "string",
    schema: z.coerce.number().min(0).max(1),
    description:
      "Window-over-window drop in mean faithfulness that counts as online-eval drift, as a fraction (0.05 = 5pp). Default 0.05.",
    sensitive: false,
  },
  ONLINE_EVAL_DRIFT_ALERTS_ENABLED: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Enable webhook drift alerts for online-eval windows (reuses EVAL_ALERT_WEBHOOK_URL). Gated independently of ONLINE_EVAL_ENABLED and OFF by default. Alerts are additionally suppressed whenever the configured judge is a stub, so this cannot page on StubRagasJudge output (#1317).",
    sensitive: false,
  },
  ONLINE_EVAL_MAX_CHARS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description:
      "Per-field character cap applied to redacted question / answer / context text before it is handed to the judge. Default 4000.",
    sensitive: false,
  },
  // `bootstrap`, NOT `tunable`: this is the only filesystem-path key in the
  // registry, and the server `mkdir -p`s it and writes into it. A `tunable`
  // filesystem path is an arbitrary-directory-write primitive for any
  // `admin.write` caller (OWASP A01/A05), so it is env-only and the API
  // rejects runtime writes. Hardening the `windowId` leaf while leaving the
  // root operator-settable would have guarded the wrong half.
  ONLINE_EVAL_RESULTS_DIR: {
    tier: "bootstrap",
    valueType: "string",
    schema: z.never(),
    description:
      "Directory for online-eval window envelopes and the token ledger. Env-only (bootstrap tier) because the server creates and writes into it. Defaults to <cwd>/eval-results/online.",
    sensitive: false,
  },
  PUBLISH_RATE_LIMIT_DELAY_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().nonnegative(),
    description: "Delay between GitHub publish requests in milliseconds.",
    sensitive: false,
  },
  PUBLISH_MAX_RETRIES: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(0).max(10),
    description: "Maximum retries for a failing GitHub publish request.",
    sensitive: false,
  },
  // ── Issue #316 — admin/mcp route rate limiting (OWASP A04) ─────────────
  ADMIN_RATE_LIMIT_MAX: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(10_000),
    description: "Maximum requests per window (per IP/user) on `/api/admin/*`. Default 60.",
    sensitive: false,
  },
  ADMIN_RATE_LIMIT_WINDOW_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000),
    description: "Rate-limit window in ms for `/api/admin/*`. Default 900000 (15 min).",
    sensitive: false,
  },
  MCP_RATE_LIMIT_MAX: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(10_000),
    description: "Maximum requests per window (per IP/user) on `/api/mcp/*`. Default 60.",
    sensitive: false,
  },
  MCP_RATE_LIMIT_WINDOW_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000),
    description: "Rate-limit window in ms for `/api/mcp/*`. Default 900000 (15 min).",
    sensitive: false,
  },
  SCHEDULER_ENABLED: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description: "Master enable for the background scheduler.",
    sensitive: false,
  },
  SCHEDULER_TICK_INTERVAL_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().positive(),
    description: "Scheduler tick interval in milliseconds.",
    sensitive: false,
  },
  MCP_HEALTH_ALLOW_PARTIAL: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description: "Allow partially-degraded MCP servers to report ready.",
    sensitive: false,
  },
  // ── Epic #270 — MCP scope hardening tunables ───────────────────────────
  MCP_REQUIRE_CATALOG: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "When true, project- and user-scoped MCP registrations must originate from the federated catalog or an admin-approved template.",
    sensitive: false,
  },
  MCP_REQUIRE_VAULT_ENV: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "When true, every MCP env value must be a ${vault:label} reference. Plaintext is rejected at the registration boundary.",
    sensitive: false,
  },
  MCP_IMAGE_ALLOWLIST: {
    tier: "tunable",
    valueType: "csv",
    schema: z.union([z.string(), z.array(z.string())]).transform((raw) => {
      const parts = (Array.isArray(raw) ? raw : raw.split(","))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return Array.from(new Set(parts));
    }),
    description:
      "Comma-separated segment-aware glob patterns of allowed container images for docker-launched MCPs (e.g. ghcr.io/metis-mcps/*). `*` matches one path segment; `**` matches multiple. Empty list rejects any docker-launched MCP.",
    sensitive: false,
  },
  MCP_ALLOW_USER_SCOPE: {
    tier: "tunable",
    valueType: "bool",
    schema: z.coerce.boolean(),
    description:
      "Feature flag for per-user MCP registrations (scope='user'). Off by default — keeps the legacy global/project model.",
    sensitive: false,
  },
  MCP_USER_MAX_CONCURRENT: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(0).max(64),
    description: "Maximum number of concurrently-enabled user-scoped MCP servers per user.",
    sensitive: false,
  },
  MCP_USER_IDLE_TIMEOUT_MIN: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(1_440),
    description:
      "Minutes of tool-invocation inactivity after which a user-scoped MCP is auto-stopped by the idle reaper.",
    sensitive: false,
  },
  // ── Epic #271 — MCP containerisation Phase A tunables ──────────────────
  MCP_DOCKER_MEMORY_LIMIT: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(2)
      .max(32)
      .regex(/^\d+(\.\d+)?(b|k|m|g)?$/i, "Invalid docker memory spec (e.g. 512m, 1g)"),
    description:
      "Memory limit for docker-stdio MCP containers (docker --memory). Examples: 256m, 512m, 1g.",
    sensitive: false,
  },
  MCP_DOCKER_CPU_LIMIT: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(1)
      .max(16)
      .regex(/^\d+(\.\d+)?$/, "Invalid docker CPU spec (e.g. 0.5, 1, 2)"),
    description:
      "CPU limit for docker-stdio MCP containers (docker --cpus). Decimal cores, e.g. 0.5, 1.0, 2.",
    sensitive: false,
  },
  MCP_DOCKER_START_TIMEOUT_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(5_000).max(120_000),
    description:
      "Startup timeout for docker-stdio MCP containers in milliseconds (covers image pull on first run).",
    sensitive: false,
  },
  MCP_DOCKER_NETWORK: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/, "Invalid docker network name"),
    description:
      "User-defined docker bridge network attached to docker-stdio MCP containers (must be created out-of-band).",
    sensitive: false,
  },
  // ── Epic #272 — MCP containerisation Phase B (k8s-sse) tunables ────────
  MCP_K8S_NAMESPACE: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9-]+$/, "Invalid k8s namespace (lowercase, digits, dash; max 63 chars)"),
    description:
      "Kubernetes namespace where per-MCP Deployments/Services/NetworkPolicies are created. Must exist in the cluster before first start.",
    sensitive: false,
  },
  MCP_K8S_SERVICE_DOMAIN: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+$/, "Invalid cluster service domain"),
    description:
      "In-cluster service DNS suffix used to build the MCP endpoint URL (e.g. cluster.local).",
    sensitive: false,
  },
  MCP_K8S_PROVISION_TIMEOUT_MS: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(30_000).max(600_000),
    description:
      "Max time to wait for a k8s-sse Deployment to become Ready before failing the provision (covers image pull + container start).",
    sensitive: false,
  },
  MCP_K8S_EGRESS_ALLOWLIST: {
    tier: "tunable",
    valueType: "csv",
    schema: z
      .union([z.string(), z.array(z.string())])
      .superRefine((raw, ctx) => {
        const parts = (Array.isArray(raw) ? raw : raw.split(","))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const p of parts) {
          try {
            validateEgressAllowlistEntry(p);
          } catch (err) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: (err as Error).message,
            });
            return;
          }
        }
      })
      .transform((raw) => {
        const parts = (Array.isArray(raw) ? raw : raw.split(","))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return Array.from(new Set(parts));
      }),
    description:
      "CSV of egress allowlist entries applied to every k8s-sse pod via NetworkPolicy. Format: cidr:10.0.0.0/8 or host:api.github.com (host:* wildcards allowed). DNS to kube-dns is always allowed. Empty list means DNS-only egress.",
    sensitive: false,
  },
  MCP_K8S_MEMORY_LIMIT: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(2)
      .max(16)
      .regex(/^\d+(Mi|Gi)$/, "Invalid k8s memory spec (e.g. 512Mi, 1Gi)")
      .refine(
        (s) => {
          if (!/^\d+(Mi|Gi)$/.test(s)) return true;
          return parseMemoryQuantityToMi(s) <= MCP_K8S_MEMORY_LIMIT_MAX_MI;
        },
        {
          message: `MCP_K8S_MEMORY_LIMIT must be ≤ ${MCP_K8S_MEMORY_LIMIT_MAX_MI}Mi (16Gi)`,
        },
      ),
    description:
      "Default memory limit for k8s-sse MCP pods (resources.limits.memory). Per-server overrides via MCPServer.k8sMemoryLimit. Hard upper bound: 16Gi.",
    sensitive: false,
  },
  MCP_K8S_MEMORY_REQUEST: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(2)
      .max(16)
      .regex(/^\d+(Mi|Gi)$/, "Invalid k8s memory spec (e.g. 128Mi)"),
    description: "Default memory request for k8s-sse MCP pods (resources.requests.memory).",
    sensitive: false,
  },
  MCP_K8S_CPU_LIMIT: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(1)
      .max(8)
      .regex(/^\d+m?$/, "Invalid k8s CPU spec (e.g. 1000m, 2)")
      .refine(
        (s) => {
          if (!/^\d+m?$/.test(s)) return true;
          return parseCpuQuantityToMilli(s) <= MCP_K8S_CPU_LIMIT_MAX_MILLI;
        },
        {
          message: `MCP_K8S_CPU_LIMIT must be ≤ ${MCP_K8S_CPU_LIMIT_MAX_MILLI}m (8 cores)`,
        },
      ),
    description:
      "Default CPU limit for k8s-sse MCP pods (resources.limits.cpu). Per-server overrides via MCPServer.k8sCpuLimit. Hard upper bound: 8000m (8 cores).",
    sensitive: false,
  },
  MCP_K8S_CPU_REQUEST: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .min(1)
      .max(8)
      .regex(/^\d+m?$/, "Invalid k8s CPU spec (e.g. 100m)"),
    description: "Default CPU request for k8s-sse MCP pods (resources.requests.cpu).",
    sensitive: false,
  },
  MCP_K8S_IRSA_ROLE_ARN_PREFIX: {
    tier: "tunable",
    valueType: "string",
    schema: z
      .string()
      .max(2048)
      .regex(
        /^(arn:aws:iam::\d{12}:role\/.+)?$/,
        "Must be empty or a valid IAM role ARN prefix (arn:aws:iam::<account>:role/<prefix>)",
      ),
    description:
      "Optional IAM role ARN prefix used to compose per-MCP IRSA roles. When set, the provisioner creates a per-server ServiceAccount annotated 'eks.amazonaws.com/role-arn: <prefix>-<server-id>'. Empty disables SA creation; pods run with default SA and no token mount.",
    sensitive: false,
  },
  MCP_K8S_LOG_LINES_PER_SEC: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(1_000),
    description:
      "Token-bucket rate limit (lines/sec) for piping k8s-sse pod logs into the METIS log stream.",
    sensitive: false,
  },
  MCP_K8S_LOG_BURST: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(10).max(5_000),
    description:
      "Token-bucket burst capacity for the k8s-sse log piper (absorbs short spikes above the per-second rate).",
    sensitive: false,
  },
  MCP_COLD_START_IDLE_MIN: {
    tier: "tunable",
    valueType: "int",
    schema: z.coerce.number().int().min(1).max(60),
    description:
      "Minutes of tool-invocation inactivity after which a cold-start k8s-sse Deployment is scaled to zero. Re-scaled to one on the next tool call.",
    sensitive: false,
  },
  DB_ALLOWED_HOSTS: {
    tier: "tunable",
    valueType: "csv",
    schema: csvHostnameSchema,
    description: "Comma-separated allowlist of database hostnames.",
    sensitive: false,
  },
  REPO_ALLOWED_HOSTS: {
    tier: "tunable",
    valueType: "csv",
    schema: csvHostnameSchema,
    description: "Comma-separated allowlist of repository hostnames.",
    sensitive: false,
  },
  PUBLISH_GITHUB_ALLOWED_HOSTS: {
    tier: "tunable",
    valueType: "csv",
    schema: csvHostnameSchema,
    description: "Comma-separated allowlist of GitHub Enterprise hostnames for publishing.",
    sensitive: false,
  },
} satisfies Record<string, ConfigKeyDef>);

export type ConfigKey = keyof typeof CONFIG_KEYS;

/** Type guard that narrows an arbitrary string to a known config key. */
export function isConfigKey(key: string): key is string {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key);
}

/** Returns the registry entry for a key, or `undefined` if unknown. */
export function getKeyDef(key: string): ConfigKeyDef | undefined {
  return CONFIG_KEYS[key];
}

/** Returns every registered key whose tier matches the predicate. */
export function listKeysByTier(tier: ConfigTier): string[] {
  return Object.entries(CONFIG_KEYS)
    .filter(([, def]) => def.tier === tier)
    .map(([k]) => k);
}
