/**
 * LLM-assisted, budget-bounded requirement→data mapping suggestions —
 * Epic #889 (#893).
 *
 * Given a requirement and the project's *ingested* database schema (retrieved
 * from the RAG knowledge base — never a live DB introspection), this proposes
 * candidate table/column mappings with normalized confidence scores and a
 * short rationale.
 *
 * Budget discipline mirrors Item A's synthesizer (#890): a configurable number
 * of LLM calls and an approximate input-token budget bound a single run. When
 * the budget is exhausted before every schema batch is processed, partial
 * results are returned with `budgetExhausted = true` and an explanatory note —
 * never runaway usage.
 *
 * This function NEVER throws: provider/RAG failures degrade to an empty result
 * with a descriptive note so the route can always answer 200.
 */
import type { SuggestDataMappingsResult, SuggestedDataMappingCandidate } from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import type { AIProvider } from "../ai/types.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { JsonLlmParseError, callJsonLlm } from "../ai/json-llm-client.js";
import { clampToModelOutputCeiling } from "../ai/model-output-limits.js";
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "../ai/providers/anthropic-provider.js";
import { OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS } from "../ai/providers/bedrock-direct-provider.js";
import { isTruncationFinishReason } from "../docs-gen/truncation.js";
import { getKnowledgeService } from "../rag/knowledge-service.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("data-mapping-suggest");

/** Filename prefix used by `connector-ingest.ts` for ingested DB schema docs. */
const DB_DOC_PREFIX = "connector:db:";

/** Default number of LLM calls allowed per suggest run. */
export const DEFAULT_SUGGEST_MAX_CALLS = 3;
/** Default approximate input-token budget per suggest run. */
export const DEFAULT_SUGGEST_TOKEN_BUDGET = 20_000;
/** Default number of schema tables described per LLM call. */
export const DEFAULT_SUGGEST_TABLES_PER_CALL = 25;
/** Default number of RAG chunks retrieved as schema context. */
export const DEFAULT_SUGGEST_RETRIEVE_K = 40;
/** Confidence at/below which a candidate is flagged low-confidence. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
/**
 * #751 AC4 — an EXPLICIT output cap per call. Unset, it inherited the
 * provider's default (4096 on the OpenAI-compatible class), and a thinking
 * model spends its reasoning from that same budget, so a 25-table batch could
 * be cut off mid-JSON. A candidate is ~60–100 tokens; 8,192 leaves the answer
 * for a full batch plus a reasoning margin, and is held at the model's own
 * output ceiling below.
 *
 * A FLOOR, not a target: #868 review — the direct Anthropic provider inherits
 * 16,000, and thinking spends 5–10k of it, so sending 8,192 there would cut
 * off batches that used to fit. The default cap is therefore the larger of
 * this and the provider's own inherited default ({@link inheritedMaxTokens}).
 */
export const DEFAULT_SUGGEST_MAX_OUTPUT_TOKENS = 8_192;

/** What a `chat()` call on this provider would get with `maxTokens` unset. */
function inheritedMaxTokens(providerKey: string | undefined): number {
  return providerKey === "anthropic"
    ? ANTHROPIC_DEFAULT_MAX_TOKENS
    : OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS;
}

export interface SuggestConfig {
  maxLlmCalls: number;
  tokenBudget: number;
  tablesPerCall: number;
  retrieveK: number;
  /** The operator's explicit cap, used as given; `null` = the default (a floor). */
  maxOutputTokens: number | null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Resolve the suggest budget from environment variables. */
export function loadSuggestConfig(env: NodeJS.ProcessEnv = process.env): SuggestConfig {
  return {
    maxLlmCalls: parsePositiveInt(env.DATA_MAPPING_SUGGEST_MAX_CALLS, DEFAULT_SUGGEST_MAX_CALLS),
    tokenBudget: parsePositiveInt(
      env.DATA_MAPPING_SUGGEST_TOKEN_BUDGET,
      DEFAULT_SUGGEST_TOKEN_BUDGET,
    ),
    tablesPerCall: parsePositiveInt(
      env.DATA_MAPPING_SUGGEST_TABLES_PER_CALL,
      DEFAULT_SUGGEST_TABLES_PER_CALL,
    ),
    retrieveK: parsePositiveInt(env.DATA_MAPPING_SUGGEST_RETRIEVE_K, DEFAULT_SUGGEST_RETRIEVE_K),
    maxOutputTokens: parsePositiveInt(env.DATA_MAPPING_SUGGEST_MAX_OUTPUT_TOKENS, 0) || null,
  };
}

// ── Dependency injection (so unit tests need no live RAG / provider) ─────────

interface RagHit {
  filename: string;
  text: string;
  score: number;
  /** #547 — `documents.source`; only a `db` hit is an ingested schema table. */
  source: string;
}
interface KnowledgeSearcher {
  search(projectId: string, query: string, opts?: { k?: number }): Promise<{ hits: RagHit[] }>;
}

export interface SuggestDeps {
  prisma?: Pick<PrismaClient, "requirement" | "databaseConnection">;
  knowledge?: KnowledgeSearcher;
  provider?: AIProvider;
  env?: NodeJS.ProcessEnv;
}

// A schema table parsed out of an ingested doc filename + chunk text.
interface SchemaTable {
  dbConnectorId: string;
  schemaName: string;
  tableName: string;
  text: string;
}

/**
 * Parse `connector:db:<connectorId>:<schema>.<table>.md` into its parts.
 * Returns null for the OVERVIEW doc or anything that doesn't match.
 */
export function parseSchemaDocFilename(
  filename: string,
): { dbConnectorId: string; schemaName: string; tableName: string } | null {
  if (!filename.startsWith(DB_DOC_PREFIX)) return null;
  const rest = filename.slice(DB_DOC_PREFIX.length); // <connectorId>:<schema>.<table>.md
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const dbConnectorId = rest.slice(0, sep);
  let tail = rest.slice(sep + 1);
  if (tail.endsWith(".md")) tail = tail.slice(0, -3);
  if (tail === "OVERVIEW" || dbConnectorId.length === 0) return null;
  const dot = tail.indexOf(".");
  if (dot < 0) return null;
  const schemaName = tail.slice(0, dot);
  const tableName = tail.slice(dot + 1);
  if (!schemaName || !tableName) return null;
  return { dbConnectorId, schemaName, tableName };
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  // Tolerate 0–100 scales by collapsing to 0–1.
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

interface RawCandidate {
  dbConnectorId?: unknown;
  schemaName?: unknown;
  tableName?: unknown;
  columnName?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

function buildBatchPrompt(requirementText: string, batch: SchemaTable[]): string {
  const schemaBlock = batch
    .map(
      (t) =>
        `### connectorId=${t.dbConnectorId} | ${t.schemaName}.${t.tableName}\n${t.text.trim()}`,
    )
    .join("\n\n");
  return (
    `Requirement:\n${requirementText}\n\n` +
    `Candidate database tables (only propose mappings to these):\n${schemaBlock}\n\n` +
    `Identify which of the above tables (and, where clearly applicable, which ` +
    `column) store the data this requirement concerns. Respond with JSON: ` +
    `{"candidates":[{"dbConnectorId":string,"schemaName":string,"tableName":string,` +
    `"columnName":string|null,"confidence":number (0-1),"rationale":string}]}. ` +
    `Only include tables from the list above. Omit tables that are clearly unrelated.`
  );
}

const SYSTEM_PROMPT =
  "You are a data-traceability analyst. You map software requirements to the " +
  "database tables and columns that implement them, using only the provided " +
  "schema. You never invent tables or columns that are not listed.";

/**
 * Run a budget-bounded suggest pass. Never throws.
 */
export async function suggestMappings(
  projectId: string,
  requirementId: string,
  deps: SuggestDeps = {},
): Promise<SuggestDataMappingsResult> {
  const empty: SuggestDataMappingsResult = {
    candidates: [],
    budgetExhausted: false,
    note: null,
  };
  try {
    const prisma = (deps.prisma ?? defaultPrisma) as PrismaClient;
    const config = loadSuggestConfig(deps.env);

    // Validate the requirement is in the project and fetch its text.
    const requirement = await prisma.requirement.findFirst({
      where: { id: requirementId, projectId, deletedAt: null },
      select: { id: true, title: true, body: true },
    });
    if (!requirement) {
      return { ...empty, note: "requirement not found in this project" };
    }
    const requirementText = `${requirement.title}\n\n${requirement.body ?? ""}`.trim();

    // RAG-retrieve the project's ingested DB schema context (no live DB).
    const knowledge = deps.knowledge ?? (getKnowledgeService() as unknown as KnowledgeSearcher);
    const query = `database tables and columns for: ${requirement.title}`;
    const { hits } = await knowledge.search(projectId, query, { k: config.retrieveK });

    // Keep only DB schema-table docs; dedupe by connector+schema+table.
    const seen = new Set<string>();
    const tables: SchemaTable[] = [];
    for (const hit of hits) {
      // #547 — an upload may carry a `connector:db:` name; its source says what it is.
      if (hit.source !== "db") continue;
      const parsed = parseSchemaDocFilename(hit.filename);
      if (!parsed) continue;
      const key = `${parsed.dbConnectorId}::${parsed.schemaName}::${parsed.tableName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tables.push({ ...parsed, text: hit.text });
    }

    if (tables.length === 0) {
      return {
        ...empty,
        note: "No ingested database schema found for this project. Ingest a database connector first.",
      };
    }

    // Resolve connector labels for display.
    const connectorIds = [...new Set(tables.map((t) => t.dbConnectorId))];
    const connectors = await prisma.databaseConnection.findMany({
      where: { id: { in: connectorIds }, projectId, deletedAt: null },
      select: { id: true, label: true },
    });
    const labelById = new Map(connectors.map((c) => [c.id, c.label]));
    // Allowed (connectorId, schema, table) tuples to reject hallucinations.
    const allowed = new Set(
      tables.map((t) => `${t.dbConnectorId}::${t.schemaName}::${t.tableName}`),
    );

    const provider = deps.provider ?? buildProvider({ config: loadAIConfig() });

    const candidates: SuggestedDataMappingCandidate[] = [];
    let callsUsed = 0;
    let tokensUsed = 0;
    let budgetExhausted = false;

    // #751 AC4 — never below what the provider would have used (#868 review),
    // and held at what the model will actually accept, so a model with a lower
    // output ceiling is not handed a value it rejects with a 400. An operator's
    // explicit value is used as given, as `ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS` is.
    const requestedMaxTokens =
      config.maxOutputTokens ??
      Math.max(DEFAULT_SUGGEST_MAX_OUTPUT_TOKENS, inheritedMaxTokens(provider.key));
    const maxTokens = clampToModelOutputCeiling(requestedMaxTokens, provider.model, undefined, {
      knob: "DATA_MAPPING_SUGGEST_MAX_OUTPUT_TOKENS",
      nonStreamingProviderKey: provider.key,
    }).value;

    const batches: SchemaTable[][] = [];
    for (let i = 0; i < tables.length; i += config.tablesPerCall) {
      batches.push(tables.slice(i, i + config.tablesPerCall));
    }

    while (batches.length > 0) {
      const batch = batches.shift()!;
      const userPrompt = buildBatchPrompt(requirementText, batch);
      const estTokens = Math.ceil((userPrompt.length + SYSTEM_PROMPT.length) / 4);

      if (callsUsed >= config.maxLlmCalls || tokensUsed + estTokens > config.tokenBudget) {
        budgetExhausted = true;
        break;
      }

      let parsed: { candidates?: RawCandidate[] };
      try {
        const result = await callJsonLlm<{ candidates?: RawCandidate[] }>(provider, {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
          maxTokens,
        });
        parsed = result.parsed ?? {};
        tokensUsed += result.response?.usage?.totalTokens ?? estTokens;
      } catch (err) {
        const truncated =
          err instanceof JsonLlmParseError && isTruncationFinishReason(err.response.finishReason);
        // A single bad batch must not abort the whole run.
        log.warn("suggest batch failed", {
          projectId,
          requirementId,
          err: (err as Error).message,
          tables: batch.length,
          ...(truncated ? { retryAsHalves: batch.length > 1 } : {}),
        });
        tokensUsed +=
          err instanceof JsonLlmParseError
            ? (err.response.usage?.totalTokens ?? estTokens)
            : estTokens;
        callsUsed += 1;
        // #751 AC4 — the output cap cut the reply off: half the tables means
        // half the answer (and less reasoning), so re-ask them as two smaller
        // batches, still inside the call and token budget. A single table that
        // truncates is skipped as before — it cannot get smaller.
        if (truncated && batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          batches.unshift(batch.slice(0, mid), batch.slice(mid));
        }
        continue;
      }
      callsUsed += 1;

      for (const raw of parsed.candidates ?? []) {
        const dbConnectorId = typeof raw.dbConnectorId === "string" ? raw.dbConnectorId : "";
        const schemaName = typeof raw.schemaName === "string" ? raw.schemaName : "";
        const tableName = typeof raw.tableName === "string" ? raw.tableName : "";
        if (!tableName) continue;
        if (!allowed.has(`${dbConnectorId}::${schemaName}::${tableName}`)) continue;
        const columnName =
          typeof raw.columnName === "string" && raw.columnName.trim().length > 0
            ? raw.columnName
            : null;
        const confidence = clampConfidence(raw.confidence);
        candidates.push({
          dbConnectorId,
          dbConnectorLabel: labelById.get(dbConnectorId) ?? null,
          schemaName,
          tableName,
          columnName,
          confidence,
          lowConfidence: confidence <= LOW_CONFIDENCE_THRESHOLD,
          rationale: typeof raw.rationale === "string" ? raw.rationale : "",
          source: "llm-suggested",
        });
      }
    }

    // Rank by confidence (desc), then dedupe identical tuples keeping the best.
    candidates.sort((a, b) => b.confidence - a.confidence);
    const deduped: SuggestedDataMappingCandidate[] = [];
    const candSeen = new Set<string>();
    for (const c of candidates) {
      const key = `${c.dbConnectorId}::${c.schemaName}::${c.tableName}::${c.columnName ?? ""}`;
      if (candSeen.has(key)) continue;
      candSeen.add(key);
      deduped.push(c);
    }

    return {
      candidates: deduped,
      budgetExhausted,
      note: budgetExhausted
        ? "Suggestion budget reached; returning partial results. Increase DATA_MAPPING_SUGGEST_MAX_CALLS or token budget for a full pass."
        : null,
    };
  } catch (err) {
    log.warn("suggestMappings failed", {
      projectId,
      requirementId,
      err: (err as Error).message,
    });
    return {
      candidates: [],
      budgetExhausted: false,
      note: `suggestion failed: ${(err as Error).message}`,
    };
  }
}
