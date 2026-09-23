/**
 * Holistic document synthesis.
 *
 * Two-phase generation:
 *   Phase 1 (per-module fact extraction): For each meaningful module,
 *           ask the LLM to extract a compact, structured list of facts
 *           (business rules, entities, workflows, formulas, key APIs).
 *   Phase 2 (holistic synthesis): Pass ALL extracted facts plus project
 *           metadata to a single LLM call that writes ONE coherent
 *           document with Mermaid diagrams.
 *
 * Three document types are supported, each with its own Phase 2 prompt:
 *   - "business-requirements" — Executive summary + business rules +
 *      workflows + glossary. Audience: business analysts, product owners.
 *   - "architecture" — System context + modules + component diagram +
 *      data model + cross-cutting concerns. Audience: developers,
 *      architects.
 *   - "user-guide" — Overview + getting started + how-to workflows +
 *      reference + glossary. Audience: end users.
 *
 * Unlike the old per-symbol approach, the output is a single narrative
 * document rather than a flat list of class summaries.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { extractFormulas, type ExtractedFormula } from "../code-graph/formula-extractor.js";
import { mineJavaRules, renderMinedRules, type MinedRule } from "../code-graph/java-rule-miner.js";
import {
  mineSasRules,
  renderMinedSasRules,
  mineSasWorkflow,
  renderSasWorkflow,
  renderSasDataLineage,
  type MinedSasStep,
} from "../code-graph/sas-rule-miner.js";
import { minePyRules, renderMinedPyRules } from "../code-graph/py-rule-miner.js";
import { mineGoRules, renderMinedGoRules } from "../code-graph/go-rule-miner.js";
import { mineTsRules, renderMinedTsRules } from "../code-graph/ts-rule-miner.js";
import { mineSqlRules, renderMinedSqlRules } from "../code-graph/sql-rule-miner.js";
import {
  buildCodeGraphSummary,
  renderCrossModuleDeps,
  renderDatasetLineageChain,
  type CodeGraphSummary,
  type GraphEdge,
  type GraphSymbol,
} from "./code-graph-summary.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { validateLocalProviderUrl } from "../ai/config.js";
import { AnthropicProvider } from "../ai/providers/anthropic-provider.js";
import {
  BedrockDirectProvider,
  OpenAICompatibleProvider,
} from "../ai/providers/bedrock-direct-provider.js";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { resolveClaimModelOverride } from "../ai/claim-model-config.js";
import {
  detectTruncation,
  describeTruncation,
  mergeTruncation,
  type TruncationDetection,
} from "./truncation.js";
import {
  modelOutputCeiling,
  resolveFactsMaxOutputTokens,
  resolveSectionMaxOutputTokens,
} from "./output-caps.js";
import {
  FACT_SLICES,
  MINED_RULES_ENTRY_CHAR_CAP,
  countFactBullets,
  dedupeRulesAgainstMined,
  parsePersistedMinedRules,
  renderMinedRuleInventory,
  sliceModuleFacts,
  toPersistedMinedRules,
  type FactSlice,
  type ModuleFactSlices,
  type PersistedMinedRule,
} from "./fact-slices.js";
import { resolvePhase1Reasoning } from "./docs-gen-reasoning.js";
import { mapSettledWithConcurrency, resolvePhase1Concurrency } from "./phase1-concurrency.js";
import {
  loadRepositorySources,
  repositoryPathIdentity,
  resolveSourcePath,
  type RepositoryIdentity,
  type RepositorySource,
} from "./repository-sources.js";
import { detectLanguage } from "../code-graph/parsers.js";
import { isJunkSourcePath } from "@metis/shared";
import { recordUsage } from "../finops/index.js";
import {
  type GroundingSource,
  type GroundingContext,
  type FactsSourceInput,
  mergeFactsIntoContext,
  renderGroundingBlock,
} from "./grounding/grounding-context.js";
import type { SectionGroundingRetriever } from "./grounding/grounding-retrieval.js";
import {
  type DocWarning,
  noModulesWarning,
  sourceUnavailableWarning,
  factsTruncatedWarning,
  phase1FactsTruncatedWarning,
  sectionFailedWarning,
  sectionTruncatedWarning,
  sectionMissingWarning,
  sectionUnfaithfulWarning,
  sectionPartlyGroundedWarning,
  sectionUnderReconstructedWarning,
  groundingUnparseableWarning,
  resolveSectionFaithfulnessThreshold,
  tierForSection,
  type DocWarningTier,
  type SectionTierSignal,
  NARRATIVE_FAITHFULNESS_THRESHOLD,
  RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
  summarizeWarnings,
} from "./grounding/degraded-warnings.js";
// #67 — the fixed, user-safe failure vocabulary a section's exception is mapped
// through before it can reach a persisted, client-visible warning.
import { generationFailureMessage, isConnectionDropped } from "./generation-failure-message.js";
import { isSasBusinessSymbol } from "./discovery-agent.js";
import { ClaimExtractor } from "./grounding/claim-extractor.js";
import {
  FaithfulnessJudge,
  DEFAULT_JUDGE_MAX_BATCH,
  MIN_BATCH_MATCH_RATIO,
} from "./grounding/faithfulness-judge.js";
import {
  CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
  FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
  JSON_OBJECT_RESPONSE_FORMAT,
  parseStructuredOutputMode,
  type StructuredOutputMode,
} from "./grounding/structured-output-schemas.js";
import {
  scoreFaithfulness,
  summarizeFaithfulness,
  type FaithfulnessResult,
} from "./grounding/citation-validator.js";
import {
  GENERATED_DOC_PROVENANCE_SCHEMA_VERSION,
  buildGeneratedDocVersionManifest,
  graphFingerprintOf,
  evidenceContentHash,
  type GeneratedDocVersionManifest,
  type GeneratedDocRevisionKey,
} from "./generated-doc-provenance.js";
import type { EvidencePolicy } from "./evidence-policy.js";
import {
  hashSectionInputs,
  recordSectionSynthesis,
  reusableSectionRecords,
  SECTION_SYNTHESIS_VERSION,
  type SectionSynthesis,
  type SectionSynthesisRecord,
} from "./section-reuse.js";

const log = createChildLogger("docs-gen:holistic");

export type DocType = "business-requirements" | "architecture" | "user-guide";

/**
 * Result of holistic synthesis. `warnings` is non-empty when one or more
 * sections failed to generate (#225) — the caller MUST surface these and avoid
 * marking the document as a clean `ready` (use {@link deriveDocStatus}).
 */
export interface HolisticSynthesisResult {
  markdown: string;
  warnings: DocWarning[];
  provenanceManifest?: string;
  sectionSupport?: Array<{ supportedClaims: number; totalClaims: number }>;
}

export interface HolisticProvenanceContext {
  revision: GeneratedDocRevisionKey;
  generatedAt: Date;
  policy: EvidencePolicy;
}

/**
 * Prompt-caching directive for a genuinely SINGLE-SHOT doc-gen call (#389).
 *
 * Both Phase-1 fact extraction (one unique per-module source) and Phase-2
 * section generation (one unique per-section facts/grounding blob) send their
 * large payload in the USER turn EXACTLY ONCE — it is never reused across
 * provider calls. A message-level cache WRITE therefore only incurs the
 * Bedrock/Anthropic write premium without a later read to amortise it, so we
 * scope caching to `system` only (the system prefix IS shared across the many
 * modules / ~6 sections and pays for itself on the second call onward).
 *
 * Multi-call sites — the agentic analysis loop and the grounding pipeline
 * (claim-extraction + faithfulness-judge reuse the same source-evidence
 * prefix across batches) — keep `messages: true` and are unaffected by this.
 *
 * Returns `undefined` when the provider does not support caching at all
 * (e.g. local Gemma), matching the previous `... : undefined` call shape.
 */
export function singleShotPromptCaching(supportsCaching: boolean): { system: true } | undefined {
  return supportsCaching ? { system: true } : undefined;
}

/**
 * Bump this whenever the Phase-1 system prompt or fact format changes
 * in a way that should invalidate the fact cache. Cache rows from a
 * different prompt version are treated as a miss and overwritten on the
 * next run.
 */
// 4 — #154/#155/#156: headings are now parsed into topic slices, every
// language's mined rules are persisted, and truncated replies are no longer cached.
const PHASE1_PROMPT_VERSION = 4;
export { PHASE1_PROMPT_VERSION, GENERATED_DOC_PROVENANCE_SCHEMA_VERSION };

/**
 * Per-provider docs-gen tuning. Each provider gets OPTIMIZED DEFAULTS suited
 * to its context window and cost profile, and EVERY knob is independently
 * overridable via a PROVIDER-NAMESPACED env var — so switching `AI_PROVIDER`
 * never lets one provider's settings leak into the other.
 *
 *   Bedrock gateway (large ~200K context, paid, prompt-caching):
 *     DOCS_GEN_BEDROCK_PHASE1_MODEL    default: BEDROCK_MODEL ?? claude-sonnet-4-6
 *     DOCS_GEN_BEDROCK_PHASE2_MODEL    default: BEDROCK_MODEL ?? claude-sonnet-4-6
 *     DOCS_GEN_BEDROCK_FACTS_CHAR_CAP  default: 150000  (~40K tokens of facts/section)
 *
 *   local-gemma / Ollama (small ~32K context, free, single-slot):
 *     DOCS_GEN_LOCAL_PHASE1_MODEL      default: gemma3:4b  (fast structured extraction)
 *     DOCS_GEN_LOCAL_PHASE2_MODEL      default: LOCAL_GEMMA_MODEL ?? gemma3:12b  (synthesis)
 *                                       Phase 2 reads LOCAL_GEMMA_MODEL DIRECTLY (not only the
 *                                       already-resolved provider model) so an operator who sets
 *                                       LOCAL_GEMMA_MODEL always gets that model in synthesis. The
 *                                       last-resort fallback is gemma3:12b, a NON-reasoning model —
 *                                       NEVER gemma4:12b, which is a reasoning model that returns
 *                                       EMPTY content via the OpenAI /v1 path at normal token budgets
 *                                       and is therefore unsuitable as the doc-gen default.
 *     DOCS_GEN_LOCAL_FACTS_CHAR_CAP    default: 48000  (~14K tokens — fits the 32K window
 *                                       so system prompt + facts + output don't overflow
 *                                       and trigger context-shift, which would silently
 *                                       drop the instructions and yield EMPTY sections).
 *                                       Raise this in lock-step with OLLAMA_CONTEXT_LENGTH.
 *
 * Bedrock defaults are NEVER affected by the LOCAL_* vars and vice-versa, so
 * each provider stays independently optimized and reversible. #108.
 */
type DocsGenProviderKind = "bedrock" | "local" | "anthropic";

/**
 * Last-resort phase-2 synthesis model for the local-gemma provider when neither
 * DOCS_GEN_LOCAL_PHASE2_MODEL nor LOCAL_GEMMA_MODEL is set. Deliberately a
 * NON-reasoning instruction-tuned model: the previous default `gemma4:12b` is a
 * reasoning model that returns EMPTY `content` via the OpenAI `/v1` path at
 * normal token budgets, which silently produced blank documentation sections.
 */
const DOCS_GEN_LOCAL_PHASE2_FALLBACK_MODEL = "gemma3:12b";

/**
 * The local-gemma default model id (mirror of `DEFAULT_LOCAL_GEMMA_MODEL` in
 * `ai/config.ts`). It is a REASONING model unsuitable for doc synthesis, so when
 * the resolved provider model is merely this bare default (i.e. the operator did
 * NOT set LOCAL_GEMMA_MODEL), phase-2 resolution skips it and uses the
 * non-reasoning {@link DOCS_GEN_LOCAL_PHASE2_FALLBACK_MODEL} instead. Kept as a
 * local literal (not imported) so this tuning file has no dependency on config
 * internals; both are simple string constants.
 */
const DEFAULT_LOCAL_REASONING_MODEL = "gemma4:12b";

export interface DocsGenTuning {
  phase1Model: string;
  phase2Model: string;
  /**
   * Model for CLAIM EXTRACTION (decompose a section into atomic claims). This is
   * a high-volume, large-output but mechanical task, so on paid providers it
   * defaults to a smaller/cheaper model (Haiku) to cut run cost. Overridable per
   * provider; for local it stays the local model (no second model to serve).
   */
  claimModel: string;
  /**
   * Model for the FAITHFULNESS JUDGE (NLI entailment: is each claim supported by
   * the evidence?). This is the TRUST-CRITICAL step — its verdicts drive the
   * "needs review" flags — and NLI is the most reasoning-heavy part of grounding,
   * so it stays on the (stronger) synthesis model rather than being downshifted
   * to Haiku. On `anthropic`/`bedrock` that is the Sonnet phase-2 model; for
   * local it is the local model. Overridable via `DOCS_GEN_*_JUDGE_MODEL`.
   */
  judgeModel: string;
  factsCharCap: number;
  supportsCaching: boolean;
  /** Phase-2 synthesis temperature. */
  temperature: number;
  /** Nucleus sampling top_p (undefined = provider/gateway default). */
  topP?: number;
  /**
   * frequency_penalty (undefined = don't send; use only for models where
   * expert routing doesn't naturally control repetition).
   * NOTE: Google's Gemma 4 model card recommends NO frequency_penalty.
   */
  frequencyPenalty?: number;
  /**
   * When true, the provider sends `think: false` to disable the model's
   * internal reasoning/thinking mode. Required for Gemma 4 with Ollama:
   * thinking mode is enabled by default and, if not disabled, the model
   * spends its full token budget on reasoning and returns empty content.
   */
  disableThinking: boolean;
  /** When true, run an extra low-temp refine pass per section (slower, better). */
  refine: boolean;
  /**
   * When true, use the SHORT system prompt variant for Phase 2. Off by default
   * because the verbose prompt's explicit depth/word-count/table mandates
   * produce markedly MORE detailed documentation. Opt in only for terse summaries. #117.
   */
  concisePrompt: boolean;
  /**
   * #336 — how the JSON-shaped grounding calls on the LOCAL/vLLM path (claim
   * extraction, faithfulness judging) request structured output via the
   * OpenAI-compatible `response_format` field. Gated to the LOCAL provider only
   * (Ollama/vLLM/LM Studio) and default `off` — Bedrock/Anthropic never set it,
   * and existing Ollama users see unchanged requests until they opt in with
   * `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT`. The provider degrades gracefully if the
   * runtime rejects the field (retry without it), so enabling it can never
   * hard-fail a call — worst case it is a no-op + one warn.
   *
   * #117 — `json_schema` (also `1`) constrains decoding to the schema and, when
   * a runtime accepts-and-ignores it, retries an unparseable reply once in
   * `json_object` mode; `json_object` asks for JSON mode with the shape in the
   * prompt, for such runtimes (`laguna-s-2.1` on Ollama 0.34.2).
   */
  structuredOutput: StructuredOutputMode;
}

/** Trimmed non-empty env string, or undefined. */
function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** Parse a float env var with a fallback; returns undefined only if asked. */
function floatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Truthy env flag (1/true/yes/on). */
function boolFromEnv(name: string): boolean {
  const raw = process.env[name];
  return raw != null && /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Parse a positive integer from an env var, clamped to a floor, with a
 * fallback when unset/invalid.
 */
function intFromEnv(name: string, fallback: number, floor: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= floor ? n : fallback;
}

/**
 * #1226 — the docs-gen output-cap resolvers moved to `./output-caps.ts` in
 * #1228 so the DB-schema synthesizer can share the SAME model-ceiling table
 * without importing this module's Phase-1/Phase-2 dependency graph. Re-exported
 * here because they are part of this module's published surface.
 */
export {
  DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
  DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
  modelOutputCeiling,
  resolveDocsGenMaxOutputTokens,
  resolveSectionMaxOutputTokens,
  resolveFactsMaxOutputTokens,
} from "./output-caps.js";

/** Resolve the optimized, independently-overridable tuning for a provider. */
export function docsGenTuning(kind: DocsGenProviderKind, configModel: string): DocsGenTuning {
  // #701 — cross-provider claim-extraction model override (config-gated via the
  // DOCS_GEN_CLAIM_MODEL registry key). Unset by default → per-provider Haiku
  // default is preserved (no behaviour change). Lowest precedence, below the
  // provider-specific DOCS_GEN_*_CLAIM_MODEL / DOCS_GEN_GROUNDING_MODEL overrides.
  const claimModelOverride = kind === "local" ? undefined : resolveClaimModelOverride();
  if (kind === "local") {
    // Google's official Gemma 4 model card mandates temperature=1.0, top_p=0.95
    // for ALL use cases. Empirical testing confirms: lower temperatures cause
    // Gemma 4's MoE routing to over-activate thinking mode, exhausting the token
    // budget on reasoning and returning EMPTY content. At temp=1.0 the model
    // produces full, detailed documentation. frequency_penalty is intentionally
    // omitted — the MoE expert routing provides diversity naturally.
    //
    // disableThinking=true is required: Ollama's Gemma 4 template enables
    // thinking by default; think:false tells it to skip the <|think|> block.
    //
    // Phase-2 model resolution (the local docs-gen fix): an operator who sets
    // LOCAL_GEMMA_MODEL=<some chat model> must get THAT model in synthesis. The
    // already-resolved provider model (`configModel`) can be masked at tuning
    // time (e.g. AI_MODEL / runtime_config overlay precedence), so we read
    // LOCAL_GEMMA_MODEL DIRECTLY here as the second-priority source. The final
    // fallback is a NON-reasoning model (never the old `gemma4:12b` reasoning
    // default, which returns empty content via /v1). Priority:
    //   1. DOCS_GEN_LOCAL_PHASE2_MODEL  (explicit phase-2 override)
    //   2. LOCAL_GEMMA_MODEL            (operator's configured local model)
    //   3. configModel                  (resolved provider model, if not the
    //                                     unsuitable reasoning default)
    //   4. DOCS_GEN_LOCAL_PHASE2_FALLBACK_MODEL (non-reasoning last resort)
    const configModelForPhase2 =
      configModel && configModel !== DEFAULT_LOCAL_REASONING_MODEL ? configModel : undefined;
    const phase2Model =
      envStr("DOCS_GEN_LOCAL_PHASE2_MODEL") ??
      envStr("LOCAL_GEMMA_MODEL") ??
      configModelForPhase2 ??
      DOCS_GEN_LOCAL_PHASE2_FALLBACK_MODEL;
    return {
      // Phase 1 stays env-overridable; gemma3:4b is fine for fast extraction.
      phase1Model: envStr("DOCS_GEN_LOCAL_PHASE1_MODEL") ?? "gemma3:4b",
      phase2Model,
      // No second local model to serve — both grounding steps reuse the phase-2
      // model unless an operator explicitly points them elsewhere.
      claimModel: envStr("DOCS_GEN_LOCAL_CLAIM_MODEL") ?? phase2Model,
      judgeModel: envStr("DOCS_GEN_LOCAL_JUDGE_MODEL") ?? phase2Model,
      factsCharCap: intFromEnv("DOCS_GEN_LOCAL_FACTS_CHAR_CAP", 48_000, 4_000),
      supportsCaching: false,
      temperature: floatFromEnv("DOCS_GEN_LOCAL_TEMPERATURE", 1.0),
      topP: floatFromEnv("DOCS_GEN_LOCAL_TOP_P", 0.95),
      disableThinking: !boolFromEnv("DOCS_GEN_LOCAL_ENABLE_THINKING"),
      refine: boolFromEnv("DOCS_GEN_LOCAL_REFINE"),
      concisePrompt: boolFromEnv("DOCS_GEN_LOCAL_CONCISE_PROMPT"),
      // #336 — opt-in structured output on the local/vLLM path. Default OFF so
      // existing Ollama users are unaffected. #117 — json_schema | json_object |
      // off, with the old 1/0 spellings kept.
      structuredOutput: parseStructuredOutputMode(process.env.DOCS_GEN_LOCAL_STRUCTURED_OUTPUT),
    };
  }
  if (kind === "anthropic") {
    // Native Anthropic (#285) — large ~200K context, paid, GA prompt caching.
    // Mirrors Bedrock's synthesis tuning (temperature 0.2, no top_p/penalty, no
    // refine, no thinking) but pins BARE Claude model ids and its own env
    // namespace so Bedrock/local settings can never leak in. supportsCaching is
    // TRUE so the provider emits `cache_control` on the system + facts prefix,
    // cutting Sonnet input cost (~65% on cache hits) with no output change.
    const anthropicModel = envStr("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
    return {
      phase1Model: envStr("DOCS_GEN_ANTHROPIC_PHASE1_MODEL") ?? anthropicModel,
      phase2Model: envStr("DOCS_GEN_ANTHROPIC_PHASE2_MODEL") ?? anthropicModel,
      // Claim extraction defaults to Haiku ($1/$5, ~3× cheaper than Sonnet) —
      // it's a high-volume but mechanical decomposition task. Override via
      // DOCS_GEN_ANTHROPIC_CLAIM_MODEL (or the cross-provider DOCS_GEN_GROUNDING_MODEL).
      claimModel:
        envStr("DOCS_GEN_ANTHROPIC_CLAIM_MODEL") ??
        envStr("DOCS_GEN_GROUNDING_MODEL") ??
        claimModelOverride ??
        "claude-haiku-4-5",
      // The faithfulness judge ALWAYS stays on the Sonnet synthesis model: its
      // verdicts drive the "needs review" flags (trust-critical) and NLI is the
      // most reasoning-heavy step, so it is NOT downshifted to Haiku. The shared
      // DOCS_GEN_GROUNDING_MODEL deliberately does NOT apply here; only the
      // dedicated DOCS_GEN_ANTHROPIC_JUDGE_MODEL can override it.
      judgeModel: envStr("DOCS_GEN_ANTHROPIC_JUDGE_MODEL") ?? anthropicModel,
      factsCharCap: intFromEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", 150_000, 4_000),
      supportsCaching: true,
      temperature: floatFromEnv("DOCS_GEN_ANTHROPIC_TEMPERATURE", 0.2),
      disableThinking: false,
      refine: false,
      concisePrompt: false,
      // #336 — structured output is a LOCAL/vLLM-only capability gate. The
      // native Anthropic provider ignores `response_format`, so never request it.
      structuredOutput: "off",
    };
  }
  const bedrockModel = envStr("BEDROCK_MODEL") ?? "us.anthropic.claude-sonnet-4-6";
  // Bedrock keeps its long-standing behaviour: temperature 0.2, NO top_p /
  // frequency_penalty (gateway defaults), NO refine pass, no thinking. Output unchanged.
  return {
    phase1Model: envStr("DOCS_GEN_BEDROCK_PHASE1_MODEL") ?? bedrockModel,
    phase2Model: envStr("DOCS_GEN_BEDROCK_PHASE2_MODEL") ?? bedrockModel,
    // Claim extraction is unchanged by default (Bedrock's Haiku inference-profile
    // id differs by region/account, so we don't presume one). Opt in to the
    // savings with DOCS_GEN_BEDROCK_CLAIM_MODEL=<haiku profile id>.
    claimModel:
      envStr("DOCS_GEN_BEDROCK_CLAIM_MODEL") ??
      envStr("DOCS_GEN_GROUNDING_MODEL") ??
      claimModelOverride ??
      bedrockModel,
    // Judge stays on the Bedrock Sonnet model (trust-critical); override only via
    // the dedicated DOCS_GEN_BEDROCK_JUDGE_MODEL.
    judgeModel: envStr("DOCS_GEN_BEDROCK_JUDGE_MODEL") ?? bedrockModel,
    factsCharCap: intFromEnv("DOCS_GEN_BEDROCK_FACTS_CHAR_CAP", 150_000, 4_000),
    supportsCaching: true,
    temperature: floatFromEnv("DOCS_GEN_BEDROCK_TEMPERATURE", 0.2),
    disableThinking: false,
    refine: false,
    concisePrompt: false,
    // #336 — capability-gated to local/vLLM only. The Bedrock gateway path does
    // not schema-constrain via `response_format`, so never request it.
    structuredOutput: "off",
  };
}

/**
 * Build a provider tailored to a docs-gen phase. local-gemma streams from
 * Ollama; otherwise we go direct to the Bedrock gateway (prompt caching +
 * per-phase model pinning) and fall back to the global provider only when no
 * gateway is configured. Returns the resolved facts-char budget so Phase 2
 * can size each section's fact blob to the provider's context window.
 */
export function buildDocsGenProvider(
  phase: 1 | 2,
  defaultMaxTokens: number,
): {
  provider: AIProvider;
  supportsCaching: boolean;
  factsCharCap: number;
  tuning: DocsGenTuning;
  effectiveConfigHash: string;
} {
  const config = loadAIConfig();

  // First-class local-gemma (Ollama) path. Uses the LOCAL_* tuning so a
  // Bedrock/Claude model id can never leak into Ollama (it would 404).
  if (config.provider === "local-gemma" && config.sdkProvider) {
    const tuning = docsGenTuning("local", config.model);
    const model = phase === 1 ? tuning.phase1Model : tuning.phase2Model;
    log.info("Using local-gemma (Ollama) for docs-gen", {
      phase,
      model,
      baseUrl: config.sdkProvider.baseUrl.replace(/\/+$/, ""),
      defaultMaxTokens,
      factsCharCap: tuning.factsCharCap,
      temperature: tuning.temperature,
      topP: tuning.topP,
      disableThinking: tuning.disableThinking,
      refine: tuning.refine,
    });
    return {
      provider: new OpenAICompatibleProvider({
        baseUrl: config.sdkProvider.baseUrl,
        apiKey: config.sdkProvider.apiKey ?? "ollama",
        model,
        providerKey: "local-gemma",
        defaultMaxTokens,
        defaultTemperature: tuning.temperature,
        defaultTopP: tuning.topP,
        defaultFrequencyPenalty: tuning.frequencyPenalty,
        disableThinking: tuning.disableThinking,
      }),
      supportsCaching: tuning.supportsCaching,
      factsCharCap: tuning.factsCharCap,
      tuning,
      // Hash only settings actually passed to this provider, never credentials
      // or Phase-2-only tuning. Capture alongside construction, not on cache read.
      effectiveConfigHash: createHash("sha256")
        .update(
          JSON.stringify({
            baseUrl: config.sdkProvider.baseUrl,
            temperature: tuning.temperature,
            topP: tuning.topP,
            frequencyPenalty: tuning.frequencyPenalty,
            disableThinking: tuning.disableThinking,
          }),
        )
        .digest("hex"),
    };
  }

  // Native Anthropic path (#285) — official SDK against api.anthropic.com. The
  // factory builds the dedicated AnthropicProvider for `provider === "anthropic"`;
  // it honours GA prompt caching via `cache_control` (see AnthropicProvider.
  // buildRequest), so supportsCaching is TRUE and the doc-gen calls request
  // `{ system: true, messages: true }`. Per-phase model pinning rides the
  // ANTHROPIC_* tuning namespace so Bedrock/local settings never leak in.
  if (config.provider === "anthropic") {
    const tuning = docsGenTuning("anthropic", config.model);
    const model = phase === 1 ? tuning.phase1Model : tuning.phase2Model;
    log.info("Using native AnthropicProvider for docs-gen", {
      phase,
      model,
      defaultMaxTokens,
      factsCharCap: tuning.factsCharCap,
      supportsCaching: tuning.supportsCaching,
    });
    return {
      // Pin the per-phase model on the provider via a model override at call
      // time is not available here, so build the provider with the resolved
      // model as its default (buildProvider reads config.model). We pass the
      // phase model through the config clone so the right tier is used.
      provider: buildProvider({ config: { ...config, model } }),
      supportsCaching: tuning.supportsCaching,
      factsCharCap: tuning.factsCharCap,
      tuning,
      effectiveConfigHash: createHash("sha256")
        .update(
          JSON.stringify({
            baseUrl: config.sdkProvider?.baseUrl,
          }),
        )
        .digest("hex"),
    };
  }

  // Bedrock Access Gateway path — direct OpenAI-compatible client so we can
  // request prompt caching and pin a per-phase Bedrock model. Uses the
  // BEDROCK_* tuning so its large-context defaults are never degraded by the
  // local caps.
  const tuning = docsGenTuning("bedrock", config.model);
  const model = phase === 1 ? tuning.phase1Model : tuning.phase2Model;
  const baseUrl = process.env.BEDROCK_GATEWAY_URL ?? process.env.BEDROCK_GATEWAY_BASE_URL;
  const apiKey =
    process.env.BEDROCK_GATEWAY_API_KEY ??
    process.env.BEDROCK_API_KEY ??
    process.env.OPENAI_API_KEY; // gateway uses OpenAI-compatible auth header

  if (baseUrl && apiKey) {
    log.info("Using BedrockDirectProvider for docs-gen", {
      phase,
      model,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      defaultMaxTokens,
      factsCharCap: tuning.factsCharCap,
    });
    return {
      provider: new BedrockDirectProvider({
        baseUrl,
        apiKey,
        model,
        defaultMaxTokens,
        defaultTemperature: tuning.temperature,
        modelProfileMap: config.modelProfileMap,
      }),
      supportsCaching: tuning.supportsCaching,
      factsCharCap: tuning.factsCharCap,
      tuning,
      effectiveConfigHash: createHash("sha256")
        .update(
          JSON.stringify({
            baseUrl,
            temperature: tuning.temperature,
            modelProfile: config.modelProfileMap?.[model],
          }),
        )
        .digest("hex"),
    };
  }

  log.warn(
    "BEDROCK_GATEWAY_URL not set; falling back to default provider (no prompt caching, no model pinning)",
  );
  return {
    provider: buildProvider({ config }),
    supportsCaching: false,
    factsCharCap: tuning.factsCharCap,
    tuning,
    effectiveConfigHash: createHash("sha256")
      .update(
        JSON.stringify({
          type: config.sdkProvider?.type,
          baseUrl: config.sdkProvider?.baseUrl,
          modelProfile: config.modelProfileMap?.[config.model],
        }),
      )
      .digest("hex"),
  };
}

/**
 * #333 — a fully-resolved Phase-2 provider plus the settings that must travel
 * WITH it (per-provider tuning, prompt-caching capability, facts-char budget).
 * `synthesizeFinalDocument` selects one of these per section under hybrid
 * routing and applies its bundle uniformly (generation, claim extraction, and
 * the faithfulness judge all use the same provider/tuning) so a local vs cloud
 * section stays independently tuned. The single-provider path builds exactly
 * one bundle and uses it for every section — byte-identical to pre-#333.
 */
export interface Phase2ProviderBundle {
  /** A stable label for logging which provider a section was routed to. */
  kind: DocsGenProviderKind;
  provider: AIProvider;
  supportsCaching: boolean;
  factsCharCap: number;
  tuning: DocsGenTuning;
}

/**
 * #333 — the per-section Phase-2 routing decision. When {@link hybrid} is null,
 * every section uses {@link primary} (the existing single-provider path,
 * unchanged). When hybrid routing is active, narrative sections go to the cloud
 * escalation provider and literal/reconstruction sections to the local
 * provider — see {@link providerForSection}.
 */
export interface Phase2Router {
  /** The single provider used when hybrid routing is OFF or unavailable. */
  primary: Phase2ProviderBundle;
  /** Present only when hybrid routing is active AND both providers resolved. */
  hybrid: { local: Phase2ProviderBundle; escalation: Phase2ProviderBundle } | null;
}

/** #333 — truthy env flag (1/true/yes/on), reusing the module's parser semantics. */
function hybridRoutingEnabled(): boolean {
  return boolFromEnv("DOCS_GEN_HYBRID_ROUTING");
}

/**
 * #333 — build the LOCAL Phase-2 provider bundle from the LOCAL_GEMMA_* env,
 * INDEPENDENT of the globally-selected `AI_PROVIDER`. Returns null when no local
 * base URL is configured. The loopback/RFC-1918 guard ({@link
 * validateLocalProviderUrl}) still gates the base URL — a public host throws,
 * exactly as the single-provider local path does.
 */
function buildLocalPhase2Bundle(defaultMaxTokens: number): Phase2ProviderBundle | null {
  const baseUrl = process.env.LOCAL_GEMMA_BASE_URL?.trim();
  if (!baseUrl) return null;
  // Reuse the same loopback/RFC-1918 guard the single-provider path enforces.
  // A misconfigured public host must never receive document content.
  validateLocalProviderUrl(baseUrl, process.env as never);
  const tuning = docsGenTuning("local", process.env.LOCAL_GEMMA_MODEL ?? "");
  return {
    kind: "local",
    provider: new OpenAICompatibleProvider({
      baseUrl,
      apiKey: process.env.LOCAL_GEMMA_API_KEY?.trim() ?? "ollama",
      model: tuning.phase2Model,
      providerKey: "local-gemma",
      defaultMaxTokens,
      defaultTemperature: tuning.temperature,
      defaultTopP: tuning.topP,
      defaultFrequencyPenalty: tuning.frequencyPenalty,
      disableThinking: tuning.disableThinking,
    }),
    supportsCaching: tuning.supportsCaching,
    factsCharCap: tuning.factsCharCap,
    tuning,
  };
}

/**
 * #333 — build the ESCALATION (Sonnet) Phase-2 provider bundle, INDEPENDENT of
 * the globally-selected `AI_PROVIDER`. Prefers the native Anthropic provider
 * (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN); falls back to the Bedrock Access
 * Gateway (BEDROCK_GATEWAY_URL + key). Returns null when neither is configured.
 * The Sonnet provider uses its OWN public path — the local loopback guard is
 * never applied to it (no cross-wiring).
 */
function buildEscalationPhase2Bundle(defaultMaxTokens: number): Phase2ProviderBundle | null {
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (anthropicKey) {
    const tuning = docsGenTuning("anthropic", process.env.ANTHROPIC_MODEL ?? "");
    const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    return {
      kind: "anthropic",
      provider: new AnthropicProvider({
        ...(process.env.ANTHROPIC_API_KEY?.trim()
          ? { apiKey: process.env.ANTHROPIC_API_KEY.trim() }
          : {}),
        ...(process.env.ANTHROPIC_AUTH_TOKEN?.trim()
          ? { authToken: process.env.ANTHROPIC_AUTH_TOKEN.trim() }
          : {}),
        ...(baseUrl ? { baseUrl } : {}),
        model: tuning.phase2Model,
      }),
      supportsCaching: tuning.supportsCaching,
      factsCharCap: tuning.factsCharCap,
      tuning,
    };
  }

  const gatewayUrl =
    process.env.BEDROCK_GATEWAY_URL?.trim() ?? process.env.BEDROCK_GATEWAY_BASE_URL?.trim();
  const gatewayKey =
    process.env.BEDROCK_GATEWAY_API_KEY?.trim() ??
    process.env.BEDROCK_API_KEY?.trim() ??
    process.env.OPENAI_API_KEY?.trim();
  if (gatewayUrl && gatewayKey) {
    const tuning = docsGenTuning("bedrock", process.env.BEDROCK_MODEL ?? "");
    const config = loadAIConfig();
    return {
      kind: "bedrock",
      provider: new BedrockDirectProvider({
        baseUrl: gatewayUrl,
        apiKey: gatewayKey,
        model: tuning.phase2Model,
        defaultMaxTokens,
        defaultTemperature: tuning.temperature,
        modelProfileMap: config.modelProfileMap,
      }),
      supportsCaching: tuning.supportsCaching,
      factsCharCap: tuning.factsCharCap,
      tuning,
    };
  }
  return null;
}

/**
 * #333 — resolve the Phase-2 routing plan. The `primary` bundle is the existing
 * single-provider build (unchanged). Hybrid routing activates ONLY when the
 * `DOCS_GEN_HYBRID_ROUTING` flag is on AND BOTH a local and an escalation
 * provider resolve; in every other case `hybrid` is null and behavior is
 * identical to the single-provider path. A clear log records why hybrid was or
 * was not enabled.
 */
export function resolvePhase2Router(defaultMaxTokens: number): Phase2Router {
  const single = buildDocsGenProvider(2, defaultMaxTokens);
  const primary: Phase2ProviderBundle = {
    // The single-provider build reports its concrete provider only via logs; for
    // routing/telemetry we label it by the globally-configured provider family.
    kind: loadAIConfig().provider === "local-gemma" ? "local" : "anthropic",
    provider: single.provider,
    supportsCaching: single.supportsCaching,
    factsCharCap: single.factsCharCap,
    tuning: single.tuning,
  };

  if (!hybridRoutingEnabled()) {
    return { primary, hybrid: null };
  }

  const local = buildLocalPhase2Bundle(defaultMaxTokens);
  const escalation = buildEscalationPhase2Bundle(defaultMaxTokens);
  if (!local || !escalation) {
    log.info("Hybrid doc-gen routing enabled but not both providers configured; using single", {
      localConfigured: local != null,
      escalationConfigured: escalation != null,
    });
    return { primary, hybrid: null };
  }

  log.info("Hybrid doc-gen per-section routing ACTIVE", {
    localModel: local.tuning.phase2Model,
    escalationKind: escalation.kind,
    escalationModel: escalation.tuning.phase2Model,
  });
  return { primary, hybrid: { local, escalation } };
}

/**
 * #333 — select the Phase-2 provider bundle for a single section by its tier.
 * Routing rule (only meaningful under hybrid routing):
 *   - narrative                 → escalation (Sonnet, long-context synthesis)
 *   - literal + reconstruction  → local (high-volume, grounding-hardened)
 * When hybrid routing is inactive, every section uses `router.primary` —
 * unchanged single-provider behavior.
 *
 * TODO(#334): judge-gated escalation plugs in HERE — a section routed to
 * `local` whose faithfulness falls below its tier threshold gets re-run on
 * `router.hybrid.escalation`. The seam is deliberately clean so #334 adds a
 * re-run without touching the initial routing decision.
 */
export function providerForSection(
  router: Phase2Router,
  group: SectionTierSignal,
): { bundle: Phase2ProviderBundle; tier: DocWarningTier } {
  const tier = tierForSection(group);
  if (!router.hybrid) return { bundle: router.primary, tier };
  const bundle = tier === "narrative" ? router.hybrid.escalation : router.hybrid.local;
  return { bundle, tier };
}

// ============================================================================
// #334 — judge-gated escalation (quality floor)
// ============================================================================
//
// After a section is generated LOCALLY and its faithfulness is judged, if the
// score falls BELOW that section's tier threshold we re-run the SAME section on
// the escalation (Sonnet/cloud) provider and keep the better result. This is a
// hard quality floor that makes local-first generation safe.
//
// Interaction with #333: escalation is only ever meaningful when hybrid routing
// is active (`router.hybrid != null`), because that is the only state in which a
// distinct local-vs-escalation provider pair exists. When hybrid routing is off,
// or no escalation provider is configured, `resolvePhase2Router` returns
// `hybrid: null` and {@link shouldEscalateSection} is a no-op — behavior is
// byte-identical to pre-#334. The two flags are INDEPENDENT: hybrid routing can
// run without escalation (route by tier, no quality floor), but escalation
// without hybrid routing is inert.

/** Sane default per-document escalation budget when the env var is unset. */
export const DEFAULT_MAX_ESCALATIONS = 3;

/**
 * #334 — resolved judge-gated-escalation config, read from env ONCE per
 * synthesis so a mid-run env mutation can't change the budget partway through.
 */
export interface EscalationConfig {
  /** Master flag (`DOCS_GEN_JUDGE_ESCALATION`), default OFF. */
  enabled: boolean;
  /** Per-document cap on escalation re-runs (`DOCS_GEN_MAX_ESCALATIONS`). */
  maxEscalations: number;
}

/** Read the judge-gated-escalation config from env. */
export function resolveEscalationConfig(): EscalationConfig {
  return {
    enabled: boolFromEnv("DOCS_GEN_JUDGE_ESCALATION"),
    // Floor of 0 lets an operator explicitly disable escalation while leaving the
    // flag on (budget exhausted from the start = no-op, keep-local behavior).
    maxEscalations: intFromEnv("DOCS_GEN_MAX_ESCALATIONS", DEFAULT_MAX_ESCALATIONS, 0),
  };
}

/** The inputs to the escalation gate, so it stays a pure, unit-testable decision. */
export interface EscalationGateInput {
  config: EscalationConfig;
  /** Whether hybrid routing resolved a distinct escalation provider (#333). */
  router: Phase2Router;
  /** The provider bundle THIS section was generated on. */
  sectionBundle: Phase2ProviderBundle;
  /** The section's verified faithfulness score, or null when unverified. */
  score: { faithfulness: number; threshold: number } | null;
  /** Escalations already spent on this document. */
  escalationsUsed: number;
}

/**
 * #334 — the escalation GATE: a pure predicate deciding whether a just-generated
 * section should be re-run on the escalation provider. Returns true ONLY when
 * ALL hold:
 *   (a) the `DOCS_GEN_JUDGE_ESCALATION` flag is ON;
 *   (b) hybrid routing resolved a distinct escalation provider (#333);
 *   (c) the section actually ran on the LOCAL provider (a cloud section has
 *       nowhere to escalate to — the escalation provider IS the ceiling);
 *   (d) the section was VERIFIED and scored strictly BELOW its tier threshold
 *       (an unverified section has no score → never escalates);
 *   (e) the per-document escalation budget is not yet exhausted.
 * The decision never loops: the caller escalates at most once per section and
 * increments `escalationsUsed`, so a re-run cannot itself trigger a re-run.
 */
export function shouldEscalateSection(input: EscalationGateInput): boolean {
  const { config, router, sectionBundle, score, escalationsUsed } = input;
  if (!config.enabled) return false;
  if (!router.hybrid) return false;
  // Only a LOCAL section can escalate; the escalation provider is the ceiling.
  if (sectionBundle !== router.hybrid.local) return false;
  if (!score) return false;
  if (score.faithfulness >= score.threshold) return false;
  if (escalationsUsed >= config.maxEscalations) return false;
  return true;
}

export interface ModuleFacts {
  repository?: RepositoryIdentity;
  modulePath: string;
  moduleName: string;
  classCount: number;
  methodCount: number;
  /** Compact JSON-ish summary the LLM produced. */
  facts: string;
  /** Formulas extracted directly from source (not LLM). */
  formulas: ExtractedFormula[];
  /** Top class names in this module, for the catalog. */
  topClasses: string[];
  /**
   * #271 — SAS dataset lineage for this module (input/output datasets),
   * derived deterministically from the code graph's `references`/`metadata.lineage`
   * edges. Null when the module has no lineage (non-SAS or no dataset edges).
   * Rendered into the facts as a `DATA_LINEAGE` section so synthesis can
   * reference dataset input→output flow.
   */
  dataLineage?: string | null;
  /**
   * Issue #330 — true when this module HAS documentable code symbols
   * (methods/classes) but ZERO of its source files could be read during
   * Phase-1 extraction (clone/extract dir missing or purged, or a cache-key
   * rebuild ran against files no longer on disk). Such facts are empty/near-empty
   * and ungrounded; the caller raises a loud `source-unavailable` document
   * warning rather than silently shipping a clean-looking but 0%-grounded doc.
   * Absent/false for legitimately code-less modules (e.g. SQL-only or virtual
   * SAS-only ModuleGroups), which carry no readable code symbols by design.
   */
  sourceUnavailable?: boolean;
  /**
   * #155 — every language's deterministically mined rules for this module
   * (Java, TS/JS, Python, Go, SAS, SQL), with `file:line`. Fed to the Rules
   * section directly, independent of whether the LLM repeated them in `facts`.
   */
  minedRules?: PersistedMinedRule[];
  /**
   * #156 — true when the Phase-1 reply was still cut off by the output-token cap
   * after the one larger-cap retry. The (partial) facts are used for this run
   * but never cached, and the caller raises a warning naming the module.
   */
  factsTruncated?: boolean;
}

interface ProjectMeta {
  name: string;
  language: string;
  totalSymbols: number;
  totalFiles: number;
}

/**
 * Generate a complete, holistic document for the given project and
 * document type. Returns finished markdown ready to display.
 *
 * @param options.repoConnectorId — when provided, only code symbols from
 *   the matching code graph (i.e. a single repo connector) are included.
 */
/**
 * Per-section progress callback (#243). Invoked at each section transition so
 * the route layer can broadcast live progress + degraded/failed-section
 * warnings over the socket job channel. Best-effort: the synthesizer never
 * awaits or depends on it, and swallows any throw.
 */
export interface SectionProgressUpdate {
  section: string;
  status: "queued" | "generating" | "done" | "degraded" | "failed";
  index: number;
  total: number;
  warning?: DocWarning;
}
export type OnSectionProgress = (update: SectionProgressUpdate) => void;

function synthesisConfigHash(
  provenance?: HolisticProvenanceContext,
  repoConnectorId?: string,
): string {
  const config = loadAIConfig();
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: config.provider,
        model: config.model,
        offline: config.offline,
        sdk: config.sdkProvider
          ? { type: config.sdkProvider.type, baseUrl: config.sdkProvider.baseUrl }
          : null,
        gatewayBaseUrl: config.gatewayBaseUrl,
        localBaseUrl: config.localBaseUrl,
        modelProfileMap: config.modelProfileMap,
        gatewayOverride: process.env.BEDROCK_GATEWAY_URL ?? process.env.BEDROCK_GATEWAY_BASE_URL,
        hybridLocalEndpoint: process.env.LOCAL_GEMMA_BASE_URL,
        anthropicEndpoint: process.env.ANTHROPIC_BASE_URL,
        scope: repoConnectorId,
        policy: provenance?.policy,
      }),
    )
    .digest("hex");
}

export async function synthesizeHolisticDocument(
  projectId: string,
  docType: DocType,
  title: string,
  options?: {
    provenance?: HolisticProvenanceContext;
    previousManifest?: GeneratedDocVersionManifest;
    repoConnectorId?: string;
    grounding?: GroundingContext;
    /**
     * #264 — per-section, query-targeted grounding retriever. When supplied,
     * each section group is grounded against sources retrieved for ITS topic
     * (label + keywords + doc title) instead of one doc-level title query.
     * A `undefined` return for a section falls back to the doc-level
     * {@link grounding} context, preserving back-compat.
     */
    groundingForSection?: SectionGroundingRetriever;
    onSectionProgress?: OnSectionProgress;
    benchmarkProviders?: {
      phase1?: ReturnType<typeof buildDocsGenProvider>;
      phase2Router?: Phase2Router;
    };
  },
): Promise<HolisticSynthesisResult> {
  const repoConnectorId = options?.repoConnectorId;
  const provenance = options?.provenance;
  const grounding = options?.grounding;
  const groundingForSection = options?.groundingForSection;
  const onSectionProgress = options?.onSectionProgress;
  log.info("Starting holistic synthesis", {
    projectId,
    docType,
    repoConnectorId,
    groundingSources: grounding?.sources.length ?? 0,
  });

  // Validate repository scope before constructing providers or loading symbols.
  const symbolWhere = await buildSymbolWhere(projectId, repoConnectorId);

  // Two-phase provider split: cheap+cached for fact extraction (Phase 1),
  // strong model for synthesis (Phase 2). Both go direct to Bedrock when
  // BEDROCK_GATEWAY_URL is set so we get prompt caching + accurate token
  // accounting; otherwise both fall back to the default provider.
  // #1226 — the provider-level DEFAULT output caps are configurable too. They
  // were hardcoded here (4096 / 8192), so every call that did not pass an
  // explicit `maxTokens` inherited the same silent ceiling as the section calls.
  const phase1 =
    options?.benchmarkProviders?.phase1 ?? buildDocsGenProvider(1, resolveFactsMaxOutputTokens());
  // #333 — Phase-2 routing plan. Off the flag (or without both providers) this
  // is a single bundle equal to `buildDocsGenProvider(2, …)`; with hybrid
  // routing it also carries the local + escalation bundles selected per section.
  const phase2Router =
    options?.benchmarkProviders?.phase2Router ??
    resolvePhase2Router(resolveSectionMaxOutputTokens());

  const repositories = await loadRepositorySources(symbolWhere);
  const [meta, { modules, rawSymbolCount, symbols }, edges] = await Promise.all([
    loadProjectMeta(projectId, symbolWhere),
    loadModules(symbolWhere, repositories),
    loadEdges(symbolWhere),
  ]);
  const scopedGraphFingerprint = graphFingerprintOf(
    symbols
      .map((symbol) => symbol.contentHash)
      .filter((contentHash): contentHash is string => typeof contentHash === "string"),
  );
  const repositoryWarnings: DocWarning[] = [...repositories.values()]
    .filter((repository) => !repository.root)
    .map((repository) => ({
      kind: "source-unavailable",
      severity: "warning",
      section: `Repository ${repository.repoConnectorId ?? repository.codeGraphId}`,
      message: `Source unavailable for repository ${repository.repoConnectorId ?? "(unlinked)"} (graph ${repository.codeGraphId}). No other repository's source was substituted.`,
    }));

  // #278 — SQL-only-directory gap. A dir under the clone with ONLY `.sql` files
  // produces no CodeSymbol rows → no CodeSymbol-derived ModuleGroup → its
  // constraints/triggers/views were never mined. Synthesize bounded, empty-syms
  // ModuleGroups for such dirs (relative to cloneDir, not already represented)
  // so the existing per-module SQL mining pass in extractModuleFacts runs on
  // them end to end. Best-effort and bounded; no schema-graph rebuild.
  let sqlModuleBudget = SQL_ONLY_MODULE_CAP;
  let sqlDirectoryBudget = SQL_SCAN_DIR_CAP;
  for (const repository of repositories.values()) {
    const cloneDir = repository.root;
    if (!cloneDir || sqlModuleBudget <= 0 || sqlDirectoryBudget <= 0) continue;
    try {
      const existingDirs = new Set(
        modules
          .filter((m) => m.repository?.codeGraphId === repository.codeGraphId)
          .map((m) => m.dir),
      );
      const sqlOnly = await discoverSqlOnlyModules(cloneDir, existingDirs, async (dir) => {
        if (sqlDirectoryBudget-- <= 0) throw new Error("SQL directory budget exhausted");
        return readdir(await resolveSourcePath(cloneDir, path.relative(cloneDir, dir)), {
          withFileTypes: true,
        });
      });
      if (sqlOnly.length > 0) {
        const admitted = sqlOnly.slice(0, sqlModuleBudget);
        const identity = {
          codeGraphId: repository.codeGraphId,
          repoConnectorId: repository.repoConnectorId,
        };
        modules.push(...admitted.map((m) => ({ ...m, repository: identity })));
        sqlModuleBudget -= admitted.length;
        log.info("Synthesized SQL-only-directory modules", {
          projectId,
          count: sqlOnly.length,
        });
      }
    } catch {
      // best-effort — never block doc generation on the SQL-only scan
    }
  }

  // #271 — build compact, budget-bounded code-graph summaries (SAS dataset
  // lineage + cross-module dependency/call flow) from the SAME DB rows the
  // synthesizer already loads (no graphify CLI dependency). These feed
  // DATA_LINEAGE into per-module facts AND an end-to-end flow block into the
  // Phase-2 synthesis prompt so workflows/architecture describe true
  // cross-module + dataset input→output flows.
  const moduleDirs = new Set(modules.map((m) => repositoryPathIdentity(m.repository, m.dir)));
  const graphSummary = buildCodeGraphSummary(
    symbols as GraphSymbol[],
    edges as GraphEdge[],
    moduleDirs,
  );

  if (modules.length === 0) {
    // Distinguish a genuinely-empty project (no symbols at all → clean empty
    // doc, no warning) from one that HAS indexed symbols but produced no
    // documentable modules. The latter is a silent failure (e.g. SAS-only
    // projects whose `function`-only symbols were dropped) and must be surfaced
    // so deriveDocStatus reports "degraded" instead of a clean "ready".
    const warnings = [
      ...repositoryWarnings,
      ...(rawSymbolCount > 0 ? [noModulesWarning(rawSymbolCount)] : []),
    ];
    if (warnings.length > 0) {
      log.warn("Empty document despite indexed symbols", {
        projectId,
        docType,
        rawSymbolCount,
      });
    }
    return { markdown: renderEmptyDocument(title, docType, meta), warnings };
  }

  log.info("Phase 1: extracting per-module facts", {
    projectId,
    moduleCount: modules.length,
    repositories: repositories.size,
  });

  // Phase 1: extract compact facts per module, keeping up to
  // DOCS_GEN_PHASE1_CONCURRENCY extractions in flight (#25 — a worker pool, not
  // fixed batches that each waited for their slowest module). Registry-backed
  // (db → env), default 3; raise it for a provider/gateway that allows more.
  const facts: ModuleFacts[] = [];
  const concurrency = resolvePhase1Concurrency();
  const phase1Start = Date.now();
  const progressEvery = Math.max(concurrency * 5, 1);
  const results = await mapSettledWithConcurrency(
    modules,
    concurrency,
    (m) =>
      extractModuleFacts(
        m,
        phase1.provider,
        phase1.supportsCaching,
        projectId,
        m.repository ? (repositories.get(m.repository.codeGraphId)?.root ?? null) : null,
        graphSummary,
        phase1.effectiveConfigHash,
      ),
    (completed, total) => {
      if (completed % progressEvery === 0 || completed === total) {
        log.info("Phase 1 progress", {
          completed,
          total,
          concurrency,
          elapsedSec: Math.round((Date.now() - phase1Start) / 1000),
        });
      }
    },
  );
  for (let j = 0; j < results.length; j++) {
    const r = results[j];
    if (r.status === "fulfilled" && r.value) {
      facts.push(r.value);
    } else if (r.status === "rejected") {
      log.warn("Module fact extraction failed", {
        err: String(r.reason),
        dir: modules[j].dir,
      });
    }
  }
  log.info("Phase 1 complete", {
    factsCount: facts.length,
    elapsedSec: Math.round((Date.now() - phase1Start) / 1000),
  });

  // #330 — collect any modules whose source could not be read so we can raise a
  // single LOUD document-level warning. Without this, those modules contribute
  // empty/ungrounded facts and the document is silently emitted at ~0% grounding
  // (the SAS `risk` Business Rules 78%→0% regression). We tally affected modules
  // out of the total set that EXPECTED to read source code.
  const phase1Warnings: DocWarning[] = [...repositoryWarnings];
  const sourceUnavailableCount = facts.filter((f) => f.sourceUnavailable).length;
  if (sourceUnavailableCount > 0) {
    const codeBackedModules = facts.filter((f) => f.methodCount > 0).length;
    log.warn("Doc-gen source unavailable for one or more modules", {
      projectId,
      docType,
      affected: sourceUnavailableCount,
      codeBackedModules,
    });
    phase1Warnings.push(
      sourceUnavailableWarning(
        sourceUnavailableCount,
        Math.max(codeBackedModules, sourceUnavailableCount),
      ),
    );
  }
  // #156 — modules whose facts the output cap cut short even after the retry.
  const truncatedModules = facts.filter((f) => f.factsTruncated).map((f) => f.moduleName);
  if (truncatedModules.length > 0) {
    log.warn("Phase 1 facts truncated for one or more modules", {
      projectId,
      docType,
      modules: truncatedModules,
    });
    phase1Warnings.push(phase1FactsTruncatedWarning(truncatedModules));
  }

  log.info("Phase 2: synthesizing holistic document", {
    projectId,
    docType,
    factsCount: facts.length,
  });

  // Phase 2: section-by-section LLM calls synthesize the final document.
  const {
    markdown,
    warnings: synthWarnings,
    sections,
    selectedEvidence,
    sectionSynthesis,
    regeneration,
  } = await synthesizeFinalDocument(
    facts,
    meta,
    docType,
    title,
    phase2Router,
    projectId,
    grounding,
    onSectionProgress,
    groundingForSection,
    graphSummary,
    {
      previousManifest: options?.previousManifest,
      // Resolved provider configuration matters even when the model name stays
      // fixed (e.g. changing an Ollama endpoint or an inference profile).
      // Persist only hashes, never credentials or endpoint/source text.
      effectiveConfigHash: synthesisConfigHash(provenance, repoConnectorId),
    },
  );

  // #330 — prepend the Phase-1 source-unavailability warning(s) so the document
  // is marked `degraded` even when Phase-2 synthesis (working from the empty
  // facts) happens to produce sections that clear the faithfulness bar.
  const warnings: DocWarning[] = [...phase1Warnings, ...synthWarnings];

  log.info("Holistic synthesis complete", {
    projectId,
    docType,
    markdownChars: markdown.length,
    warnings: warnings.length,
    degraded: warnings.length > 0 ? summarizeWarnings(warnings) : undefined,
  });
  const provenanceManifest = buildGeneratedDocVersionManifest({
    revision: provenance?.revision ?? { projectId, generatedDocumentId: "pending", version: 1 },
    title,
    scope: repoConnectorId ? "repository" : "full",
    docType,
    generatedAt: provenance?.generatedAt ?? new Date(),
    policy: provenance?.policy ?? {
      projectId,
      generatedDocumentId: provenance?.revision.generatedDocumentId ?? "pending",
      actor: { userId: "system", role: "admin" },
      aclSubjects: [],
      ...(repoConnectorId ? { repoConnectorId } : {}),
      ...(repoConnectorId ? { codeGraphId: symbolWhere.codeGraphId } : {}),
      sharedDocumentIds: [],
      allowWebResearch: false,
    },
    phase1Tuning: phase1.tuning,
    phase2Router,
    phase1PromptVersion: PHASE1_PROMPT_VERSION,
    selectedEvidence,
    graphFingerprint: scopedGraphFingerprint,
    sourceRepositories: facts.map((f) => {
      if (!f.repository) return undefined;
      return {
        ...f.repository,
        commitSha: repositories.get(f.repository.codeGraphId)?.commitSha ?? null,
      };
    }),
    sections,
    sectionSynthesis,
    regeneration,
  });
  return {
    markdown,
    warnings,
    provenanceManifest,
    sectionSupport: sections
      .map((section) => {
        const record = sectionSynthesis?.records.find(
          (candidate) => candidate.metadata.sectionIndex === section.sectionIndex,
        );
        const score = record?.score;
        if (!score || score.result.totalClaims === 0) return null;
        return {
          supportedClaims: score.result.supportedClaims,
          totalClaims: score.result.totalClaims,
        };
      })
      .filter((value): value is { supportedClaims: number; totalClaims: number } => value !== null),
  };
}

// ============================================================================
// Phase 0: Project metadata + module discovery
// ============================================================================

async function loadProjectMeta(
  projectId: string,
  symbolWhere: { projectId: string; codeGraphId?: string },
): Promise<ProjectMeta> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  // Group by file (with per-file symbol counts) so we can EXCLUDE OS/archive
  // junk (`__MACOSX/.../._*.sas`, `.DS_Store`, …) from BOTH the file count and
  // the symbol count. The `risk` upload ingested 182 "files", 91 of which were
  // macOS AppleDouble stubs; counting them made the model report "the majority
  // of 182 files had empty method bodies." After filtering, the header/prompt
  // reflect only real source files. (Fixes existing data without re-ingest.)
  const fileGroupsRaw = await prisma.codeSymbol.groupBy({
    by: ["codeGraphId", "filePath"],
    where: symbolWhere,
    _count: { _all: true },
  });
  const fileGroups = fileGroupsRaw.filter((fg) => !isJunkSourcePath(fg.filePath));
  const totalSymbols = fileGroups.reduce((sum, fg) => sum + (fg._count?._all ?? 0), 0);
  // Infer dominant language from file extensions.
  const extCounts = new Map<string, number>();
  for (const fg of fileGroups) {
    const ext = fg.filePath.split(".").pop() ?? "";
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const topExt = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const language =
    {
      ts: "TypeScript",
      tsx: "TypeScript",
      js: "JavaScript",
      jsx: "JavaScript",
      py: "Python",
      java: "Java",
      go: "Go",
    }[topExt] ??
    (topExt || "unknown");
  return {
    name: project?.name ?? "Unknown Project",
    language,
    totalSymbols,
    totalFiles: fileGroups.length,
  };
}

export interface ModuleGroup {
  repository?: RepositoryIdentity;
  dir: string;
  syms: Array<{
    id: string;
    qualifiedName: string;
    kind: string;
    /**
     * Source language of the symbol. Present at runtime because `loadModules`
     * selects the full `codeSymbol` row (no `select`); used by the SAS-relaxed
     * documentable-module rule via {@link isSasBusinessSymbol}.
     */
    language?: string | null;
    filePath: string;
    startLine: number;
    endLine: number;
  }>;
}

/**
 * Build a prisma `where` clause for codeSymbol queries, optionally scoped
 * to the code graph belonging to a specific repo connector.
 */
async function buildSymbolWhere(
  projectId: string,
  repoConnectorId?: string,
): Promise<{ projectId: string; codeGraphId?: string }> {
  if (repoConnectorId === undefined) return { projectId };
  const { requireRepositoryGraph } = await import("./evidence-policy.js");
  return { projectId, codeGraphId: await requireRepositoryGraph(projectId, repoConnectorId) };
}

/**
 * #271 — load all code edges for the project/graph so the synthesizer can
 * build SAS dataset lineage + cross-module dependency summaries from the
 * SAME DB source it already uses (no graphify CLI). Selects only the columns
 * the summary needs. Best-effort: returns [] on any failure so synthesis is
 * never blocked by edge loading.
 */
async function loadEdges(symbolWhere: {
  projectId: string;
  codeGraphId?: string;
}): Promise<GraphEdge[]> {
  try {
    const rows = await prisma.codeEdge.findMany({
      where: {
        projectId: symbolWhere.projectId,
        ...(symbolWhere.codeGraphId ? { codeGraphId: symbolWhere.codeGraphId } : {}),
        kind: { in: ["calls", "imports", "references"] },
      },
      select: {
        kind: true,
        fromSymbolId: true,
        toSymbolId: true,
        toQualifiedName: true,
        metadata: true,
      },
    });
    return rows as GraphEdge[];
  } catch (err) {
    log.warn("Edge load failed (continuing without code-graph summary)", {
      err: String(err),
    });
    return [];
  }
}

async function loadModules(
  symbolWhere: { projectId: string; codeGraphId?: string },
  repositories: Map<string, RepositorySource>,
): Promise<{
  modules: ModuleGroup[];
  rawSymbolCount: number;
  symbols: GraphSymbol[];
}> {
  const symbolsAll = await prisma.codeSymbol.findMany({
    where: symbolWhere,
    orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
  });
  // Drop OS/archive junk (`__MACOSX/.../._*.sas`, `.DS_Store`, …) BEFORE any
  // counting or grouping. These ingest as empty module symbols and otherwise
  // (a) inflate `rawSymbolCount` — which gates the "indexed but no modules"
  // degraded warning — and (b) leak into the returned graph symbols. Filtering
  // here lets EXISTING (already-ingested) projects produce clean docs without a
  // re-ingest. (SAS doc-gen grounding fix.)
  const symbols = symbolsAll.filter((s) => !isJunkSourcePath(s.filePath));
  const rawSymbolCount = symbols.length;
  const moduleMap = new Map<string, ModuleGroup>();
  for (const sym of symbols) {
    if (sym.kind === "module" || sym.kind === "type") continue;
    const dir = sym.filePath.split("/").slice(0, -1).join("/");
    if (
      dir.includes("/test/") ||
      dir.includes("/tests/") ||
      dir.includes("/generated/") ||
      dir.includes("/node_modules/") ||
      dir.includes("/build/") ||
      dir.includes("/target/") ||
      dir.includes("/.next/")
    ) {
      continue;
    }
    const repository: RepositoryIdentity = {
      codeGraphId: sym.codeGraphId,
      repoConnectorId: repositories.get(sym.codeGraphId)?.repoConnectorId ?? null,
    };
    const key = repositoryPathIdentity(repository, dir);
    if (!moduleMap.has(key)) moduleMap.set(key, { dir, repository, syms: [] });
    moduleMap.get(key)!.syms.push(sym);
  }

  // Split mega-modules (>200 symbols) into per-file sub-modules.
  // This ensures we actually read code from all important classes, not just
  // the top 20 methods from a 5000-symbol directory.
  const SPLIT_THRESHOLD = 200;
  const finalModules: ModuleGroup[] = [];

  for (const { dir, syms, repository } of moduleMap.values()) {
    if (syms.length <= SPLIT_THRESHOLD) {
      // Normal module — keep as-is if it qualifies.
      //
      // Standard rule (unchanged): ≥1 class/interface OR ≥4 methods/functions,
      // AND ≥3 symbols total. SAS programs have no classes/interfaces (they are
      // `%macro` blocks, DATA steps, and PROC steps — all `function` symbols
      // from the SAS parser), so a SAS dir with exactly 3 functions is dropped
      // by the standard rule. Mirror discovery-agent's relaxation: a directory
      // also qualifies when it has ≥3 SAS business-logic symbols, regardless of
      // class/interface count. The non-SAS rule is unchanged. (SAS doc-gen bug.)
      const standard =
        (syms.filter((s) => s.kind === "class" || s.kind === "interface").length >= 1 ||
          syms.filter((s) => s.kind === "method" || s.kind === "function").length >= 4) &&
        syms.length >= 3;
      const sasRelaxed = syms.filter(isSasBusinessSymbol).length >= 3;
      if (standard || sasRelaxed) {
        finalModules.push({ dir, syms, repository });
      }
    } else {
      // Mega-module: split by source file. Each file becomes its own module if
      // it qualifies. Standard: ≥1 class/interface AND ≥3 symbols. SAS files
      // never have a class, so apply the SAME SAS relaxation per-file: ≥3 SAS
      // business-logic symbols qualifies the file. (SAS doc-gen bug.)
      const byFile = new Map<string, ModuleGroup["syms"]>();
      for (const s of syms) {
        if (!byFile.has(s.filePath)) byFile.set(s.filePath, []);
        byFile.get(s.filePath)!.push(s);
      }
      for (const [filePath, fileSyms] of byFile.entries()) {
        const standard =
          fileSyms.filter((s) => s.kind === "class" || s.kind === "interface").length >= 1 &&
          fileSyms.length >= 3;
        const sasRelaxed = fileSyms.filter(isSasBusinessSymbol).length >= 3;
        if (standard || sasRelaxed) {
          // Use filePath (without extension) as the module "dir" for naming purposes.
          finalModules.push({ dir: filePath.replace(/\.[^.]+$/, ""), syms: fileSyms, repository });
        }
      }
    }
  }

  // Bumped from 50 -> 150: at 50, only ~3% of a 1,487-file monolith's files were
  // contributing facts. 150 modules at the per-module budget below covers
  // ~70% of source. Phase 2 still ranks-and-tiers via buildRelevantFactsBlob,
  // so extra modules don't blow the synthesis budget — they just give us a
  // larger candidate pool of high-density rule-bearing modules.
  const modules = finalModules.sort((a, b) => b.syms.length - a.syms.length).slice(0, 150);
  // #271 — return the raw symbols too so the caller can build the code-graph
  // summary (lineage + cross-module deps) without re-querying the DB.
  const graphSymbols: GraphSymbol[] = symbols.map((s) => ({
    id: s.id,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
    repository: {
      codeGraphId: s.codeGraphId,
      repoConnectorId: repositories.get(s.codeGraphId)?.repoConnectorId ?? null,
    },
  }));
  return { modules, rawSymbolCount, symbols: graphSymbols };
}

/**
 * Minimal directory entry shape used by {@link discoverSqlOnlyModules}. Matches
 * the subset of `fs.Dirent` we rely on, so the scan is trivially testable with
 * an in-memory `readdir` stub.
 */
interface DirEntryLike {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}
type ReaddirWithTypes = (dir: string) => Promise<DirEntryLike[]>;

/** Directory segments that never carry documentable schema. */
const SQL_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "test",
  "tests",
  "generated",
  "build",
  "target",
  ".next",
  "dist",
  "vendor",
]);
/** Cap on synthesized SQL-only modules, same order as the per-module SQL caps. */
const SQL_ONLY_MODULE_CAP = 24;
/** Cap on directories visited during the scan so a huge clone can't run away. */
const SQL_SCAN_DIR_CAP = 2000;

/**
 * Discover directories under the clone that contain `.sql` files but are NOT
 * represented by any CodeSymbol-derived module (#278). SQL is not a
 * code-graph-parsed language, so a directory holding ONLY `.sql` files yields no
 * CodeSymbol rows → no ModuleGroup → its constraints/triggers/views are never
 * mined. This helper synthesizes bounded, empty-`syms` ModuleGroups for such
 * directories whose `dir` is relative to `cloneDir`, so the existing per-module
 * SQL mining pass in {@link extractModuleFacts} resolves and mines them.
 *
 * Bounded on every axis: skips test/build/vendor dirs, caps the number of
 * directories visited ({@link SQL_SCAN_DIR_CAP}) and the number of synthesized
 * modules ({@link SQL_ONLY_MODULE_CAP}). Best-effort — any fs error is swallowed
 * (returns whatever was found so far). The `readdir` impl is injectable for
 * tests; production passes the node:fs/promises `readdir`.
 */
export async function discoverSqlOnlyModules(
  cloneDir: string,
  existingModuleDirs: Set<string>,
  readdirImpl: ReaddirWithTypes = (dir) => readdir(dir, { withFileTypes: true }),
): Promise<ModuleGroup[]> {
  const out: ModuleGroup[] = [];
  let visited = 0;
  // BFS queue of relative dirs ("" === clone root).
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < SQL_ONLY_MODULE_CAP && visited < SQL_SCAN_DIR_CAP) {
    const rel = queue.shift()!;
    visited += 1;
    let entries: DirEntryLike[];
    try {
      entries = await readdirImpl(path.resolve(cloneDir, rel));
    } catch {
      continue; // unreadable dir — skip
    }
    let hasSql = false;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SQL_SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        queue.push(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".sql")) {
        hasSql = true;
      }
    }
    // Only synthesize for non-root dirs that hold SQL and aren't already a
    // CodeSymbol-derived module.
    if (hasSql && rel.length > 0 && !existingModuleDirs.has(rel)) {
      out.push({ dir: rel, syms: [] });
    }
  }
  return out;
}

// ============================================================================
// Phase 1: per-module fact extraction
// ============================================================================

/**
 * Phase-1 per-module fact extraction. Exported so the deterministic
 * SAS-workflow/lineage enrichment (which is appended to the returned `facts`
 * even on the offline path) is unit-testable end to end without a live model.
 */
/** Max ids per `symbolId IN (...)` chunk when looking up a module's rationale findings. */
const RATIONALE_QUERY_CHUNK = 500;

export async function extractModuleFacts(
  m: ModuleGroup,
  provider: AIProvider,
  supportsCaching: boolean,
  projectId: string,
  cloneDir: string | null,
  graphSummary?: CodeGraphSummary,
  effectiveConfigHash?: string,
): Promise<ModuleFacts | null> {
  const classes = m.syms.filter((s) => s.kind === "class" || s.kind === "interface");
  // Sorted by size DESC so largest (most rule-dense) methods are read
  // first within the budget. Many Java validators have 30-60 small
  // methods — caps below intentionally generous to avoid silent drops.
  const allMethods = m.syms
    .filter((s) => s.kind === "method" || s.kind === "function")
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine));

  // Dynamic per-module budget. Tiny utility modules don't need 60K of
  // snippet context — we were paying ~3x more per module than necessary.
  // Tier by total symbol count (rough proxy for module complexity):
  const symCount = m.syms.length;
  let snippetBudget: number;
  let methodCap: number;
  if (symCount <= 10) {
    snippetBudget = 18_000;
    methodCap = 25;
  } else if (symCount <= 50) {
    snippetBudget = 36_000;
    methodCap = 50;
  } else {
    snippetBudget = 60_000;
    methodCap = 80;
  }
  const methods = allMethods.slice(0, methodCap);

  // CRITICAL FIX: previously the loop did `if (filesRead.has(sym.filePath)) continue;`
  // which meant only the FIRST method per file was ever sliced. Now we read each file
  // ONCE (cached), then slice EVERY method from it. Coverage of method
  // bodies jumps from ~10% to ~95% within the budget.
  const codeSnippets: string[] = [];
  const allFormulas: ExtractedFormula[] = [];
  const allMinedRules: MinedRule[] = [];
  // #271 — SAS-mined rules (subsetting IF/WHERE/retain, PROC options, macro
  // params). Separate array because the SAS miner has its own rule shape.
  const allSasRules: ReturnType<typeof mineSasRules> = [];
  // SAS workflow steps (DATA/PROC pipeline) + per-step dataset lineage, mined
  // deterministically from the same SAS slices. These populate the WORKFLOWS and
  // DATA_LINEAGE facts so the Workflows / Data-Model sections describe REAL step
  // sequences + dataset reads/writes instead of inferred structure (SAS doc-gen
  // grounding fix).
  const allSasSteps: MinedSasStep[] = [];
  // #274 — Python / Go / TS+JS mined rules. Each miner has its OWN rule shape
  // (distinct `kind` unions), so each gets a dedicated array, mirroring SAS.
  const allPyRules: ReturnType<typeof minePyRules> = [];
  const allGoRules: ReturnType<typeof mineGoRules> = [];
  const allTsRules: ReturnType<typeof mineTsRules> = [];
  // #274 — SQL rules are mined at the FILE level (no CodeSymbol rows for .sql);
  // populated by a separate bounded clone-dir pass below, not the symbol loop.
  const allSqlRules: ReturnType<typeof mineSqlRules> = [];
  const fileSourceCache = new Map<string, string[]>();
  const SNIPPET_BUDGET = snippetBudget;
  let totalChars = 0;

  for (const sym of methods) {
    if (totalChars > SNIPPET_BUDGET) break;
    try {
      const sourceId = repositoryPathIdentity(m.repository, sym.filePath);
      let lines = fileSourceCache.get(sourceId);
      if (!lines) {
        const absPath = await resolveSourcePath(cloneDir, sym.filePath);
        const fullSource = await readFile(absPath, "utf-8");
        lines = fullSource.split("\n");
        fileSourceCache.set(sourceId, lines);
      }
      // Per-method slice cap bumped from 120 -> 300 lines so we don't
      // truncate long state-machine switches or multi-step validators.
      const slice = lines
        .slice(sym.startLine - 1, Math.min(sym.endLine, sym.startLine + 300))
        .join("\n");
      codeSnippets.push(`// ${sym.qualifiedName}\n${slice}`);
      totalChars += slice.length;
      const lang = detectLanguage(sym.filePath);
      if (lang) {
        allFormulas.push(...extractFormulas(slice, sym.filePath, lang));
      }
      // Java-specific deterministic rule mining: catches Bean Validation
      // annotations, Preconditions.checkArgument, throw new XxxException,
      // and switch/case state machines that the LLM frequently glosses over.
      if (lang === "java") {
        allMinedRules.push(...mineJavaRules(slice, sym.filePath, sym.startLine, sym.qualifiedName));
      }
      // #271 — SAS-specific deterministic rule mining: subsetting IF / WHERE
      // row filters, IF/THEN/ELSE branch logic, RETAIN carried state,
      // KEEP/DROP field selection, PROC options + SQL clauses, and macro
      // parameter contracts — the SAS business logic the LLM glosses over.
      if (lang === "sas") {
        allSasRules.push(...mineSasRules(slice, sym.filePath, sym.startLine, sym.qualifiedName));
        // Mine the DATA/PROC step pipeline + per-step dataset lineage from the
        // same slice so Workflows / Data-Model facts are grounded in real code.
        allSasSteps.push(...mineSasWorkflow(slice, sym.filePath, sym.startLine).steps);
      }
      // #274 — Python deterministic rule mining: if/elif guards & validations,
      // raise/assert conditions, threshold constants, pydantic Field()
      // constraints, validator decorators, early returns.
      if (lang === "py") {
        allPyRules.push(...minePyRules(slice, sym.filePath, sym.startLine, sym.qualifiedName));
      }
      // #274 — Go deterministic rule mining: guard clauses, errors.New /
      // fmt.Errorf failure modes, switch business branches, const thresholds.
      if (lang === "go") {
        allGoRules.push(...mineGoRules(slice, sym.filePath, sym.startLine, sym.qualifiedName));
      }
      // #274 — TS/JS deterministic rule mining: if/ternary guards, thrown-error
      // conditions, zod schema constraints, enum/union constraints, constants.
      if (lang === "ts" || lang === "js") {
        allTsRules.push(...mineTsRules(slice, sym.filePath, sym.startLine, sym.qualifiedName));
      }
    } catch {
      // unreadable — file may have been deleted or path is wrong
    }
  }

  // #274 — SQL file-level mining. SQL is NOT a code-graph-parsed language, so
  // there are no CodeSymbol rows to dispatch on. Instead we scan this module's
  // directory under the clone dir for `.sql` files and mine each at the FILE
  // level (baseLine = 1, context = file path). Bounded by SQL_FILE_CAP files
  // and SQL_CHAR_CAP total chars to keep extraction cheap, mirroring the
  // snippet budget above. Best-effort: any fs/parse failure is swallowed.
  if (cloneDir) {
    const SQL_FILE_CAP = 12;
    const SQL_CHAR_CAP = 80_000;
    try {
      const moduleAbsDir = await resolveSourcePath(cloneDir, m.dir);
      const entries = await readdir(moduleAbsDir, { withFileTypes: true });
      const sqlFiles = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sql"))
        .slice(0, SQL_FILE_CAP);
      let sqlChars = 0;
      for (const e of sqlFiles) {
        if (sqlChars > SQL_CHAR_CAP) break;
        try {
          const relPath = path.join(m.dir, e.name);
          const sqlSource = await readFile(await resolveSourcePath(cloneDir, relPath), "utf-8");
          sqlChars += sqlSource.length;
          allSqlRules.push(...mineSqlRules(sqlSource.slice(0, SQL_CHAR_CAP), relPath, 1, relPath));
        } catch {
          // unreadable individual .sql file — skip
        }
      }
    } catch {
      // module dir not present in clone (e.g. virtual module) — no SQL to mine
    }
  }

  // Issue #330 — detect the silent "source unavailable" degradation. A module
  // that HAS code-symbol methods to read but read ZERO source files (every
  // readFile above threw into the swallow-catch) produced empty facts: the
  // clone/extract dir is missing or was purged, or a cache-key change forced a
  // rebuild against files no longer on disk. We flag this so the caller raises a
  // LOUD document warning instead of silently shipping a 0%-grounded doc, and we
  // skip the cache write below so the empty facts don't poison future runs.
  //
  // We only flag modules that EXPECTED to read source (≥1 method/function
  // symbol). SQL-only and virtual SAS-only ModuleGroups carry no readable code
  // symbols by design (their content is mined from the clone dir separately),
  // so a zero-file read there is normal, not a degradation.
  const expectedReadableFiles = new Set(methods.map((s) => s.filePath)).size;
  const sourceUnavailable = expectedReadableFiles > 0 && fileSourceCache.size === 0;
  if (sourceUnavailable) {
    log.warn("Module source unavailable — facts extracted from no source", {
      modulePath: m.dir,
      projectId,
      expectedFiles: expectedReadableFiles,
      cloneDir: cloneDir ?? "(not found)",
    });
  }

  // A module's symbol count is unbounded (a large SQL-heavy directory can carry
  // thousands), and `symbolId: { in: moduleSymbolIds } }` binds one parameter per
  // id — past the driver's bound-parameter limit that throws "query parameter
  // limit ... exceeded" and drops the whole module's facts. Chunk it (same
  // pattern as `symbol-embedding-service.ts`'s `RETAG_CHUNK`), stopping once 8
  // rationale rows are found since that's all `take: 8` ever wanted.
  const moduleSymbolIds = m.syms.map((s) => s.id);
  const rationale: Array<{ body: string }> = [];
  for (let i = 0; i < moduleSymbolIds.length && rationale.length < 8; i += RATIONALE_QUERY_CHUNK) {
    const batch = await prisma.finding.findMany({
      where: {
        agentResult: { analysis: { projectId } },
        category: { in: ["rationale", "rationale-todo"] },
        symbolId: { in: moduleSymbolIds.slice(i, i + RATIONALE_QUERY_CHUNK) },
      },
      take: 8 - rationale.length,
      select: { body: true },
    });
    rationale.push(...batch);
  }

  const shortName = m.dir.split("/").slice(-3).join("/") || m.dir;
  const moduleName = m.repository
    ? `${m.repository.repoConnectorId ?? m.repository.codeGraphId} / ${shortName}`
    : shortName;
  const topClasses = classes
    .slice(0, 15)
    .map((c) => c.qualifiedName.split(/[.:]/).pop() ?? c.qualifiedName);

  // #271 — DATA_LINEAGE for this module (SAS dataset input/output), derived
  // deterministically from the code graph's `references`/`metadata.lineage`
  // edges. Spliced into both the Phase-1 prompt (so the LLM ties rules to
  // datasets) and the returned facts (so Phase-2 synthesis sees it).
  const dataLineage =
    graphSummary?.perModuleLineage.get(repositoryPathIdentity(m.repository, m.dir)) ?? null;

  // #155 — every language's mined rules in ONE language-neutral shape. This is
  // what is persisted (`minedRulesJson`) and what reaches the Rules section
  // directly; before #155 only the Java rules were persisted and the rest were
  // discarded once the Phase-1 prompt had been built.
  const minedRules: PersistedMinedRule[] = [
    ...toPersistedMinedRules("java", allMinedRules),
    ...toPersistedMinedRules(
      "ts",
      allTsRules.filter((r) => detectLanguage(r.filePath) !== "js"),
    ),
    ...toPersistedMinedRules(
      "js",
      allTsRules.filter((r) => detectLanguage(r.filePath) === "js"),
    ),
    ...toPersistedMinedRules("py", allPyRules),
    ...toPersistedMinedRules("go", allGoRules),
    ...toPersistedMinedRules("sas", allSasRules),
    ...toPersistedMinedRules("sql", allSqlRules),
  ];

  // SAS workflow + source-derived dataset lineage, rendered once and reused in
  // BOTH the Phase-1 prompt and the appended facts (so they survive the fact
  // cache and reach Phase-2 generation + the citable facts set). These are
  // source-derived (per-step), complementing the code-graph `dataLineage` above
  // and filling it in when the graph edges are thin/empty for this module.
  const sasWorkflow = allSasSteps.length > 0 ? { steps: allSasSteps } : null;
  const sasWorkflowBlock = sasWorkflow ? renderSasWorkflow(sasWorkflow, 6000) : "";
  const sasStepLineageBlock = sasWorkflow ? renderSasDataLineage(sasWorkflow, 4000) : "";

  // ------------------------------------------------------------------
  // Phase-1 source fingerprints (lookup follows prompt construction below).
  //
  // Keep these module-local: lineage/mined changes must invalidate this module,
  // not every module in the project. Prompt hashes also cover selected symbol
  // metadata, rationale findings and the exact rendered/truncated inventories.
  //
  // Source mining still runs on every call, including hits. Persist formulas
  // alongside facts, but also key their complete metadata (not just the rendered
  // prompt subset) so changed symbol ranges cannot return stale locations.
  // ------------------------------------------------------------------
  const fileShas = Array.from(fileSourceCache.entries())
    .map(([fp, lines]) => `${fp}:${createHash("sha1").update(lines.join("\n")).digest("hex")}`)
    .sort();
  const minedFingerprint = createHash("sha1")
    .update(
      [
        ...allMinedRules.map((r) => `${r.kind}|${r.expression}`),
        // #271 — SAS rules + DATA_LINEAGE participate in the fingerprint so a
        // change to either (new dataset edge, new mined SAS rule) invalidates
        // the cached LLM facts.
        ...allSasRules.map((r) => `${r.kind}|${r.expression}`),
        // SAS workflow steps + source-derived lineage participate in the
        // fingerprint so a change to the step pipeline invalidates cached facts.
        ...allSasSteps.map(
          (s) => `step|${s.kind}|${s.name}|${s.reads.join(",")}|${s.writes.join(",")}`,
        ),
        // #274 — Python / Go / TS / SQL mined rules participate in the
        // fingerprint so any new mined rule invalidates the cached LLM facts.
        ...allPyRules.map((r) => `${r.kind}|${r.expression}`),
        ...allGoRules.map((r) => `${r.kind}|${r.expression}`),
        ...allTsRules.map((r) => `${r.kind}|${r.expression}`),
        ...allSqlRules.map((r) => `${r.kind}|${r.expression}`),
        `lineage:${dataLineage ?? ""}`,
      ].join("\n"),
    )
    .digest("hex");
  const systemMessage = `You are a senior software analyst. You will be given source code from one module of a larger system. Extract a COMPREHENSIVE, STRUCTURED set of facts about this module. Your output will be combined with facts from many other modules to produce a holistic document.

OUTPUT FORMAT (use these exact section headings):

PURPOSE
2-3 sentences: what business/technical role does this module play? What domain problem does it solve?

ENTITIES
Bullet list of ALL business/data entities defined or manipulated here. Format: \`EntityName\` — description including key fields/properties and their business meaning.

RULES
EXHAUSTIVE bullet list of EVERY business rule, validation rule, eligibility check, constraint, threshold, status transition, and invariant enforced by this module. For each rule:
- State the exact condition (quote constants, field names, numeric thresholds)
- State the consequence when the rule is violated (rejected, flagged, default applied, etc.)
- If a rule has multiple branches or edge cases, enumerate each
THIS IS THE MOST CRITICAL SECTION. Include every if/else, every validation, every boundary check. Do NOT summarize — enumerate.

WORKFLOWS
Bullet list of multi-step processes. For each workflow:
- Name it
- List the complete sequence of steps in order (numbered)
- Note decision points, branching conditions, and their outcomes
- Note error/exception paths

FORMULAS
Bullet list of ALL calculations, derived values, and formulas. For each:
- Plain English description
- The exact formula/expression (use LaTeX where appropriate)
- Explain each variable/term

INTEGRATIONS
External systems, databases, queues, APIs this module talks to. For each:
- What data is sent/received
- When/why the integration is invoked

KEY_APIS
Public methods/endpoints the rest of the system or external users call. Format: \`MethodOrPath(params)\` — purpose, preconditions, postconditions, and return value meaning.

STATUS_TRANSITIONS
If this module manages any entity states/statuses, list ALL valid transitions. Format: \`State A\` → \`State B\` — trigger/condition. If none, write "(none)".

NOTES
Anything noteworthy: caching strategies, scheduling, security constraints, performance implications, known edge cases.

ABSOLUTE RULES:
1. Be EXHAUSTIVE and SPECIFIC. Quote actual names, thresholds, codes, and types from the code. Do NOT generalize — every individual check is a separate bullet point.
2. Use domain language, not Java/Python jargon. Say "Generators must be certified" not "the certify() method runs validation".
3. Output ONLY the structured sections above. No preamble, no closing remarks. Start with "PURPOSE".
4. Use BULLETS only — no prose paragraphs. Short, dense, information-packed bullet points. One fact per bullet.
5. Be EXHAUSTIVE — there is NO word limit on this fact extraction. If a module enforces 60 distinct rules, output 60 bullets in RULES. Do not summarize, do not abbreviate, do not omit "obvious" checks. The downstream synthesis pass cannot recover facts you discard here. Quantity of facts > prose quality. A 1500-word fact dump is BETTER than a 600-word polished summary.
6. Write each heading ALONE on its own line, spelled exactly as above (no "#", no "**", no numbering). A program splits your output on these headings and sends each topic only to the document section that needs it, so a fact under the wrong heading reaches the wrong section.`;

  const userMessage = `Module path: \`${moduleName}\`
Top classes/interfaces (${classes.length} total): ${topClasses.join(", ")}
Total methods: ${m.syms.filter((s) => s.kind === "method" || s.kind === "function").length}

Source code (largest methods first, full bodies — this is the COMPLETE business logic, extract EVERY rule and check you see):
\`\`\`
${codeSnippets.join("\n\n---\n\n").slice(0, 60000)}
\`\`\`

${
  allFormulas.length > 0
    ? `Pre-extracted formulas/constants/conditionals (deterministic regex pass — these are STARTING POINTS, find more in the source above):\n${allFormulas
        .slice(0, 60)
        .map((f) => `- ${f.kind}: ${f.expression.slice(0, 200)}`)
        .join("\n")}`
    : ""
}

${allMinedRules.length > 0 ? `\n=== DETERMINISTICALLY-MINED RULE INVENTORY (${allMinedRules.length} rules) ===\nThe following rules were extracted by AST-aware regex passes and are GUARANTEED to be present in the source. EVERY ONE of these MUST appear as a bullet in your RULES section, paraphrased into business language. Do NOT omit any of them — they are not optional. Use them as a checklist; then ADD any additional rules you find by reading the source code above.\n\n${renderMinedRules(allMinedRules, 12000)}\n=== END MINED RULES ===\n` : ""}

${allSasRules.length > 0 ? `\n=== DETERMINISTICALLY-MINED SAS RULE INVENTORY (${allSasRules.length} rules) ===\nThese SAS DATA-step / PROC-step rules were extracted by deterministic passes and are GUARANTEED present in the source. EVERY subsetting IF / WHERE filter, IF/THEN/ELSE branch, RETAIN, KEEP/DROP, PROC option, and macro parameter below MUST appear as a bullet in your RULES (or WORKFLOWS / ENTITIES) section, paraphrased into business language. Do NOT omit any.\n\n${renderMinedSasRules(allSasRules, 12000)}\n=== END SAS MINED RULES ===\n` : ""}

${sasWorkflowBlock ? `\n=== DETERMINISTICALLY-MINED SAS STEP PIPELINE (${allSasSteps.length} steps) ===\nThis is the ACTUAL ordered DATA/PROC step pipeline extracted from the source. Use it to populate your WORKFLOWS section: describe these steps IN ORDER, what each does, and the datasets each reads/writes. Do NOT claim a module "has empty bodies" — these are the real steps.\n\n${sasWorkflowBlock}\n=== END SAS STEP PIPELINE ===\n` : ""}

${sasStepLineageBlock ? `\n=== DETERMINISTICALLY-MINED SAS DATASET LINEAGE (per step, from source) ===\nReads/writes per step, extracted from SET/MERGE/UPDATE/DATA=/OUT=/CREATE TABLE/OUTPUT. Use these to populate ENTITIES (each dataset is an entity) and to tie each WORKFLOW step to its input/output datasets.\n\n${sasStepLineageBlock}\n=== END SAS DATASET LINEAGE ===\n` : ""}

${allPyRules.length > 0 ? `\n=== DETERMINISTICALLY-MINED PYTHON RULE INVENTORY (${allPyRules.length} rules) ===\nThese Python rules (if/elif guards, raise/assert conditions, threshold constants, pydantic Field() constraints, validator decorators, early returns) were extracted by deterministic passes and are GUARANTEED present in the source. EVERY ONE below MUST appear as a bullet in your RULES section, paraphrased into business language. Do NOT omit any.\n\n${renderMinedPyRules(allPyRules, 12000)}\n=== END PYTHON MINED RULES ===\n` : ""}

${allGoRules.length > 0 ? `\n=== DETERMINISTICALLY-MINED GO RULE INVENTORY (${allGoRules.length} rules) ===\nThese Go rules (guard clauses, errors.New / fmt.Errorf failure modes, switch business branches, const thresholds) were extracted by deterministic passes and are GUARANTEED present in the source. EVERY ONE below MUST appear as a bullet in your RULES section, paraphrased into business language. Do NOT omit any.\n\n${renderMinedGoRules(allGoRules, 12000)}\n=== END GO MINED RULES ===\n` : ""}

${allTsRules.length > 0 ? `\n=== DETERMINISTICALLY-MINED TYPESCRIPT RULE INVENTORY (${allTsRules.length} rules) ===\nThese TypeScript/JavaScript rules (if/ternary guards, thrown-error conditions, zod schema constraints, enum/union constraints, numeric/string constants) were extracted by deterministic passes and are GUARANTEED present in the source. EVERY ONE below MUST appear as a bullet in your RULES section, paraphrased into business language. Do NOT omit any.\n\n${renderMinedTsRules(allTsRules, 12000)}\n=== END TYPESCRIPT MINED RULES ===\n` : ""}

${allSqlRules.length > 0 ? `\n=== DETERMINISTICALLY-MINED SQL RULE INVENTORY (${allSqlRules.length} rules) ===\nThese SQL schema rules (CHECK constraints, NOT NULL, UNIQUE, PRIMARY/FOREIGN KEY referential rules, DEFAULT values, triggers, view WHERE filters, stored-proc conditionals) were extracted from the module's .sql files by deterministic passes and are GUARANTEED present. EVERY ONE below MUST appear as a bullet in your RULES (or ENTITIES) section, paraphrased into business language. Do NOT omit any.\n\n${renderMinedSqlRules(allSqlRules, 12000)}\n=== END SQL MINED RULES ===\n` : ""}

${dataLineage ? `\n=== DATA_LINEAGE (this module's dataset reads/writes, from the code graph) ===\n${dataLineage}\nWhen describing WORKFLOWS, tie each step to the datasets it reads and writes using the lineage above.\n=== END DATA_LINEAGE ===\n` : ""}

${rationale.length > 0 ? `Developer rationale comments:\n${rationale.map((r) => `- ${r.body.slice(0, 200)}`).join("\n")}` : ""}

Extract ALL facts now. Be EXHAUSTIVE — every validation, every conditional, every business rule.`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemMessage },
    { role: "user", content: userMessage },
  ];

  const maxTokens = resolveFactsMaxOutputTokens(provider.model);
  // #25 — bound a thinking-by-default model's reasoning on this mechanical
  // extraction; `{}` (no change) for every other model.
  const reasoning = resolvePhase1Reasoning(provider.model);
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        module: repositoryPathIdentity(m.repository, m.dir),
        fileShas,
        minedFingerprint,
        formulas: allFormulas,
        promptVersion: PHASE1_PROMPT_VERSION,
        system: createHash("sha256").update(systemMessage).digest("hex"),
        user: createHash("sha256").update(userMessage).digest("hex"),
        provider: provider.key,
        model: provider.model ?? "default",
        effectiveConfigHash,
        maxTokens,
        supportsCaching,
        // Facts extracted at a different reasoning setting are different facts;
        // omitted when empty so an unchanged (Claude) request keeps its key.
        ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
      }),
    )
    .digest("hex");

  if (!provider.offline && !sourceUnavailable) {
    try {
      const cached = await prisma.docsGenFactCache.findUnique({
        where: { projectId_cacheKey: { projectId, cacheKey } },
      });
      if (cached) {
        log.info("Phase 1 cache HIT", {
          modulePath: m.dir,
          model: cached.model,
          age: Math.round((Date.now() - cached.createdAt.getTime()) / 1000),
        });
        // Touch lastUsedAt + bump hit counter (fire-and-forget; no need
        // to block on the write).
        prisma.docsGenFactCache
          .update({
            where: { id: cached.id },
            data: { lastUsedAt: new Date(), hitCount: { increment: 1 } },
          })
          .catch((err) => log.debug("cache touch failed", { err: String(err) }));
        return {
          repository: m.repository,
          modulePath: m.dir,
          moduleName,
          classCount: cached.classCount,
          methodCount: cached.methodCount,
          facts: cached.facts,
          formulas: JSON.parse(cached.formulasJson) as ExtractedFormula[],
          topClasses: JSON.parse(cached.topClassesJson) as string[],
          // The module-local fingerprint includes lineage, so a hit means
          // the lineage embedded in the cached facts is still current.
          dataLineage,
          // #155 — read the persisted inventory back through the cache (the key
          // covers every source file's hash, so its lines are current). A legacy
          // Java-only row cannot be parsed as the new shape → use this run's.
          minedRules: parsePersistedMinedRules(cached.minedRulesJson) ?? minedRules,
        };
      }
    } catch (err) {
      log.warn("Cache lookup failed (proceeding to LLM)", {
        err: String(err),
        modulePath: m.dir,
      });
    }
  }

  let factsText: string = "";
  let usagePromptTokens = 0;
  let usageCompletionTokens = 0;
  let usageCacheReadTokens = 0;
  // #156 — true when the reply was still cut off by the output cap after the
  // one larger-cap retry; such facts are used for this run but never cached.
  let factsTruncated = false;
  if (provider.offline) {
    factsText = `PURPOSE\n${moduleName} module.\n\nENTITIES\n${topClasses.map((c) => `- \`${c}\``).join("\n")}\n\nRULES\n(none extracted in offline mode)\n\nWORKFLOWS\n(none)\n\nFORMULAS\n(none)\n\nINTEGRATIONS\n(none)\n\nKEY_APIS\n(none)\n\nNOTES\n(none)`;
  } else {
    let reply = await streamPhase1Facts(provider, messages, {
      projectId,
      modulePath: m.dir,
      maxTokens,
      reasoning,
      supportsCaching,
    });
    // #156 — a reply that stopped at the OUTPUT cap is incomplete: 12 of 143
    // onyourleft modules were cut at gemma3:12b's 8,192 tokens and cached as if
    // complete. Retry ONCE with a larger cap (bounded by the model's known
    // ceiling); if there is no larger cap to give, or the retry is cut off too,
    // keep the partial facts for this run but flag them so they are not cached.
    if (reply.ok && reply.truncation.truncated) {
      const retryCap = phase1RetryMaxTokens(maxTokens, provider.model);
      log.warn("Phase 1 facts truncated by the output-token cap", {
        modulePath: m.dir,
        moduleName,
        maxTokens,
        retryOutputCap: retryCap,
        finishReason: reply.truncation.reason,
        signals: reply.truncation.signals,
      });
      if (retryCap !== null) {
        const retry = await streamPhase1Facts(provider, messages, {
          projectId,
          modulePath: m.dir,
          maxTokens: retryCap,
          reasoning,
          supportsCaching,
        });
        // A failed retry keeps the first (truncated) reply rather than
        // throwing the partial facts away.
        if (retry.ok) reply = retry;
      }
      factsTruncated = reply.truncation.truncated;
      if (factsTruncated) {
        log.warn("Phase 1 facts still truncated after retry — not caching", {
          modulePath: m.dir,
          moduleName,
          maxTokens: retryCap ?? maxTokens,
        });
      }
    }
    if (reply.ok) {
      factsText = reply.text;
      usagePromptTokens = reply.usage.promptTokens;
      usageCompletionTokens = reply.usage.completionTokens;
      usageCacheReadTokens = reply.usage.cacheReadTokens;
    } else {
      log.warn("Phase 1 LLM call failed", { err: String(reply.error), modulePath: m.dir });
      factsText = `PURPOSE\n${moduleName} (extraction failed)\n\nENTITIES\n${topClasses.map((c) => `- \`${c}\``).join("\n")}`;
    }
  }

  // #271 — append a deterministic DATA_LINEAGE section so the dataset
  // input/output flow survives the Phase-1 fact cache AND reaches Phase-2
  // synthesis verbatim (via factsModuleEntry), regardless of whether the LLM
  // chose to echo it. Idempotent: only append when not already present.
  if (dataLineage && !factsText.includes("\nDATA_LINEAGE\n")) {
    factsText = `${factsText.trimEnd()}\n\nDATA_LINEAGE\n${dataLineage}`;
  }

  // SAS doc-gen grounding fix — append the deterministically-mined DATA/PROC
  // step pipeline + source-derived per-step lineage to the facts so they:
  //   (1) survive the Phase-1 fact cache (stored in `facts`),
  //   (2) reach Phase-2 generation via `factsModuleEntry`, and
  //   (3) become CITABLE grounding sources (buildSectionFactsSources renders the
  //       same `factsModuleEntry`), so workflow/lineage claims resolve instead of
  //       being judged unsupported.
  // We use the WORKFLOWS / DATA_LINEAGE header tokens so selectRelevantFacts
  // scores these modules for the Key Workflows + Data & Domain Model sections.
  // The model previously wrote meta-commentary ("empty bodies") here; these are
  // the real, source-grounded steps. Idempotent via the distinct sub-headers.
  if (sasWorkflowBlock && !factsText.includes("DETERMINISTIC SAS STEP PIPELINE")) {
    factsText = `${factsText.trimEnd()}\n\nWORKFLOWS\n(DETERMINISTIC SAS STEP PIPELINE — source-grounded, mined from DATA/PROC steps)\n${sasWorkflowBlock}`;
  }
  if (sasStepLineageBlock && !factsText.includes("DETERMINISTIC SAS DATASET LINEAGE")) {
    factsText = `${factsText.trimEnd()}\n\nDATA_LINEAGE\n(DETERMINISTIC SAS DATASET LINEAGE — source-grounded, per step)\n${sasStepLineageBlock}`;
  }

  // Persist to cache (best-effort; failures here must NOT break the
  // synthesis pipeline). Skip on the synthetic offline output and on
  // failure-fallback output to avoid poisoning the cache.
  if (
    !provider.offline &&
    factsText &&
    !factsText.includes("(extraction failed)") &&
    // #330 — never persist facts extracted from zero source: a cache HIT would
    // later return the empty facts WITHOUT re-attempting the read, hiding the
    // degradation permanently even after the source is restored.
    !sourceUnavailable &&
    // #156 — never persist facts the output cap cut short: every later run
    // would reuse the incomplete version.
    !factsTruncated
  ) {
    try {
      const fileFingerprint = createHash("sha1")
        .update(fileShas.join("\n"))
        .digest("hex")
        .slice(0, 16);
      await prisma.docsGenFactCache.upsert({
        where: { projectId_cacheKey: { projectId, cacheKey } },
        create: {
          projectId,
          cacheKey,
          modulePath: m.dir,
          fileFingerprint,
          model: provider.model ?? "unknown",
          promptVersion: PHASE1_PROMPT_VERSION,
          facts: factsText,
          formulasJson: JSON.stringify(allFormulas),
          minedRulesJson: JSON.stringify(minedRules),
          topClassesJson: JSON.stringify(topClasses),
          classCount: classes.length,
          methodCount: m.syms.filter((s) => s.kind === "method" || s.kind === "function").length,
          inputTokens: usagePromptTokens,
          outputTokens: usageCompletionTokens,
          cacheReadTokens: usageCacheReadTokens,
        },
        update: {
          facts: factsText,
          formulasJson: JSON.stringify(allFormulas),
          minedRulesJson: JSON.stringify(minedRules),
          topClassesJson: JSON.stringify(topClasses),
          model: provider.model ?? "unknown",
          inputTokens: usagePromptTokens,
          outputTokens: usageCompletionTokens,
          cacheReadTokens: usageCacheReadTokens,
          lastUsedAt: new Date(),
        },
      });
    } catch (err) {
      log.debug("cache write failed", { err: String(err), modulePath: m.dir });
    }
  }

  return {
    repository: m.repository,
    modulePath: m.dir,
    moduleName,
    classCount: classes.length,
    methodCount: m.syms.filter((s) => s.kind === "method" || s.kind === "function").length,
    facts: factsText,
    formulas: allFormulas,
    topClasses,
    dataLineage,
    sourceUnavailable,
    minedRules,
    ...(factsTruncated ? { factsTruncated } : {}),
  };
}

/** Outcome of one Phase-1 facts stream (after the gateway-error retry). */
type Phase1Reply =
  | {
      ok: true;
      text: string;
      truncation: TruncationDetection;
      usage: { promptTokens: number; completionTokens: number; cacheReadTokens: number };
    }
  | { ok: false; error: unknown };

/**
 * #156 — the larger OUTPUT cap for the one retry of a truncated Phase-1 reply:
 * double the cap, clamped to the model's known output ceiling. `null` when the
 * cap is already at that ceiling, so there is nothing larger to ask for.
 */
export function phase1RetryMaxTokens(maxTokens: number, model: string | undefined): number | null {
  const ceiling = modelOutputCeiling(model);
  const doubled = maxTokens * 2;
  const retry = ceiling === null ? doubled : Math.min(doubled, ceiling);
  return retry > maxTokens ? retry : null;
}

/**
 * Stream one Phase-1 fact extraction and report whether the reply was cut off
 * by the output cap (#156). Streaming (not a blocking call) keeps bytes flowing
 * so a gateway ALB's 60s idle timeout does not kill a large-context call; the
 * stream setup is retried once on a 502/503/504. Never throws: a failure is
 * returned as `{ ok: false }` so the caller can fall back.
 */
async function streamPhase1Facts(
  provider: AIProvider,
  messages: ChatMessage[],
  opts: {
    projectId: string;
    modulePath: string;
    maxTokens: number;
    reasoning: ReturnType<typeof resolvePhase1Reasoning>;
    supportsCaching: boolean;
  },
): Promise<Phase1Reply> {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 5_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const sessionId = `docs-facts-${opts.projectId}-${opts.modulePath.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}-${randomBytes(3).toString("hex")}`;
      const chunks: string[] = [];
      const usage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 };
      let finishReason: string | undefined;
      for await (const chunk of provider.stream(messages, {
        sessionId,
        disableTools: true,
        // #1226 — configurable OUTPUT cap, clamped to the model's known ceiling.
        maxTokens: opts.maxTokens,
        ...opts.reasoning,
        // #390 — tag prompt-cache hit-ratio telemetry by workload.
        callType: "synthesis",
        // Cache ONLY the stable system prompt — it is shared across every
        // module's Phase-1 call. The large per-module SOURCE in the user turn is
        // unique to THIS module, so a message-level cache write would just burn
        // the write premium with no later read to amortise it (#389).
        promptCaching: singleShotPromptCaching(opts.supportsCaching),
      })) {
        if (chunk.type === "delta") {
          chunks.push(chunk.content);
        } else if (chunk.type === "usage") {
          usage.promptTokens = chunk.usage.promptTokens;
          usage.completionTokens = chunk.usage.completionTokens;
          usage.cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
        } else if (chunk.type === "done") {
          finishReason = chunk.finishReason;
        }
      }
      // Record token usage for the project usage dashboard.
      if (usage.promptTokens > 0 || usage.completionTokens > 0) {
        recordUsage({
          projectId: opts.projectId,
          sessionId,
          provider: provider.key,
          model: provider.model,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cacheReadTokens: usage.cacheReadTokens,
        });
      }
      // Both signals: the provider's stop reason and the gateway's placeholder
      // body (which is also stripped so it can never be cached as facts).
      const truncation = detectTruncation(chunks.join(""), finishReason);
      return { ok: true, text: truncation.text.trim(), truncation, usage };
    } catch (err) {
      lastErr = err;
      const errStr = String(err);
      const isGatewayTimeout = /\b(502|503|504)\b/.test(errStr);
      if (isGatewayTimeout && attempt < MAX_RETRIES - 1) {
        log.warn("Phase 1 stream setup failed, retrying", {
          modulePath: opts.modulePath,
          attempt: attempt + 1,
          delaySec: Math.round(RETRY_DELAY_MS / 1000),
          err: errStr.slice(0, 200),
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      break;
    }
  }
  return { ok: false, error: lastErr };
}

// ============================================================================
// Phase 2: holistic synthesis (section-by-section LLM calls)
// ============================================================================
//
// Rather than asking the LLM for a 5000-word document in one shot (which
// hits output token caps and triggers "I'll synthesize..." preamble-only
// responses), we split each document type into 4-5 focused section
// groups. Each group is a single LLM call producing ~800-1500 words.
// The pieces are then concatenated into the final document.

export interface SectionGroup {
  /** Stable id for logging. */
  id: string;
  /** Human label. */
  label: string;
  /** The detailed instructions the LLM follows for this section group only. */
  instructions: string;
  /**
   * #283 — OPTIONAL per-section faithfulness threshold in [0,1]. When set, it
   * overrides the global {@link faithfulnessThreshold} for THIS section only.
   * Inherently-abstractive narrative sections (Overview & Domain, Core Business
   * Capabilities) set a lower bar ({@link NARRATIVE_FAITHFULNESS_THRESHOLD}) so
   * mandated domain narrative isn't false-flagged against the code-fidelity bar.
   * Omitted on code-derived sections → they keep the global 0.80.
   */
  faithfulnessThreshold?: number;
  /**
   * #283 — when true this is a narrative/abstractive section, so a below-threshold
   * result yields the HONEST {@link sectionPartlyGroundedWarning} ("X% grounded;
   * remainder is domain context") rather than the alarming
   * {@link sectionUnfaithfulWarning} ("may be unreliable").
   */
  narrative?: boolean;
  /**
   * When true this is a RECONSTRUCTION section (Key Workflows, Data & Domain
   * Model) gated at the moderate {@link RECONSTRUCTION_FAITHFULNESS_THRESHOLD}.
   * A below-threshold result yields {@link sectionUnderReconstructedWarning}
   * ("inferred — verify against source"), which frames the gap as mandated
   * structural inference rather than fabrication (the literal
   * {@link sectionUnfaithfulWarning}) or domain narrative (the abstractive
   * {@link sectionPartlyGroundedWarning}). Mutually exclusive with `narrative`.
   */
  reconstruction?: boolean;
  /**
   * #154 — the Phase-1 fact slices this section reads. Its facts blob AND its
   * citable `facts:` sources carry only these slices of each module, so a
   * section no longer pays for every module's unrelated topics. Omitted → the
   * default for the group's id ({@link factSlicesFor}).
   */
  factSlices?: readonly FactSlice[];
  /**
   * #155 — when true, each module's deterministic mined-rule inventory (every
   * language, with `file:line`) is part of this section's input, independent of
   * the LLM summary. Omitted → true for the Rules sections only.
   */
  minedRules?: boolean;
}

/** Outcome of post-validating one synthesized section against its grounding. */
interface SectionGroundingOutcome {
  /** Section markdown, with confidently-matched ungrounded claims stripped. */
  markdown: string;
  /** A `section-ungrounded` warning when ungrounded claims were found, else null. */
  warning: DocWarning | null;
  /**
   * #334 — the numeric faithfulness of THIS section in [0,1], and the threshold
   * it was gated at, when the section was actually VERIFIED (a real claim-level
   * judge score was produced). `null` when the section could not be verified
   * (offline judge, empty context, no claims, or a scoring error) — in which case
   * judge-gated escalation MUST NOT fire, because "unverified" is not "below the
   * bar". Exposed so the per-section loop can decide whether to escalate a local
   * section WITHOUT re-running the judge.
   */
  score: { faithfulness: number; threshold: number; result: FaithfulnessResult } | null;
}

/**
 * #334 — build the correctly-framed `section-ungrounded` warning for a section
 * whose faithfulness fell below its tier bar. Extracted from
 * {@link validateSectionGrounding} so the per-section loop can re-derive the
 * warning for whichever output (local or escalated) it ultimately keeps, using
 * the SAME copy-selection rules — no divergence between the two paths.
 */
function buildFaithfulnessWarning(
  sectionLabel: string,
  result: FaithfulnessResult,
  threshold: number,
  section?: { narrative?: boolean; reconstruction?: boolean },
): DocWarning {
  const breakdown = {
    supportedClaims: result.supportedClaims,
    totalClaims: result.totalClaims,
    faithfulness: result.faithfulness,
    threshold,
  };
  if (section?.narrative) return sectionPartlyGroundedWarning(sectionLabel, breakdown);
  if (section?.reconstruction) return sectionUnderReconstructedWarning(sectionLabel, breakdown);
  return sectionUnfaithfulWarning(sectionLabel, breakdown);
}

/**
 * #273 — per-section entailment-based FAITHFULNESS pass (replaces the old
 * #223/#224 extract → cite-id → strip pass).
 *
 * Business-requirements docs are abstractive synthesis over many modules, so an
 * accurate cross-module claim is entailed by the section's facts bundle as a
 * whole but maps to no single pre-existing `sourceId`. The old validator
 * required id reproduction and therefore structurally false-flagged correct
 * synthesis as ungrounded → the whole doc went `degraded` (the SAS `risk-calc`
 * "Overview & Domain" 98/98 case). We now decompose the section into atomic
 * claims and ask the {@link FaithfulnessJudge} whether each is ENTAILED BY the
 * grounding context (the judge sees the source TEXT, not just ids), scoring
 * RAGAS-style supported/total. A section is flagged only when its faithfulness
 * falls BELOW the threshold ({@link faithfulnessThreshold}) — not on any single
 * unsupported claim.
 *
 * The section markdown is NEVER mutated here: under entailment we keep the
 * accurate synthesis intact and surface a numeric ratio instead of deleting
 * lines that "didn't cite an id". (The old line-stripping behaviour is gone; it
 * only existed to remove uncited-but-true sentences.)
 *
 * Robustness: an UNVERIFIABLE section (offline judge, empty context, parse/count
 * failure) is pass-through with no warning — we never assert a section is
 * unfaithful when we could not actually verify it. Any thrown error degrades
 * only THIS section to pass-through, never crashing synthesis (#225 contract).
 * The `section-failed` path remains reserved for true generation failures.
 */
async function validateSectionGrounding(
  sectionLabel: string,
  sectionMarkdown: string,
  claimExtractor: ClaimExtractor | null,
  faithfulnessJudge: FaithfulnessJudge | null,
  grounding: GroundingContext | undefined,
  projectId: string,
  /**
   * #283 — per-section gating: the resolved threshold for THIS section and
   * whether it is a narrative or reconstruction section (selects which
   * warning-copy variant to emit when below the bar).
   */
  section?: { threshold?: number; narrative?: boolean; reconstruction?: boolean },
): Promise<SectionGroundingOutcome> {
  if (
    !claimExtractor ||
    !faithfulnessJudge ||
    !grounding ||
    grounding.isEmpty ||
    !sectionMarkdown
  ) {
    return { markdown: sectionMarkdown, warning: null, score: null };
  }

  try {
    const result = await scoreFaithfulness(sectionLabel, sectionMarkdown, grounding, {
      extractor: claimExtractor,
      judge: faithfulnessJudge,
    });

    // #117 — a grounding reply that did not parse is NOT "nothing to check":
    // the section is surfaced as unverified instead of passing silently.
    const unparseableWarning = result.unparseable
      ? groundingUnparseableWarning(sectionLabel, result.unparseable)
      : null;
    if (unparseableWarning) {
      log.warn("Section grounding reply could not be parsed; section not fully verified", {
        projectId,
        section: sectionLabel,
        stage: result.unparseable,
      });
    }

    // Unverifiable or no claims → keep the section, NO score (so #334
    // escalation never fires on an unverified section — "unverified" is not
    // "below the bar"), and no warning unless a reply was unparseable.
    if (!result.verified || result.totalClaims === 0) {
      return { markdown: sectionMarkdown, warning: unparseableWarning, score: null };
    }

    // #283 — resolve the threshold for THIS section: an explicit per-section
    // override (narrative sections set a lower bar) wins over the global default.
    const threshold = resolveSectionFaithfulnessThreshold(section?.threshold);
    const score = { faithfulness: result.faithfulness, threshold, result };
    if (result.faithfulness >= threshold) {
      // Faithful enough — accurate synthesis stays `ready`, unless some of the
      // judge's batches were unparseable and their claims went unscored (#117).
      return { markdown: sectionMarkdown, warning: unparseableWarning, score };
    }

    log.warn("Section faithfulness below threshold", {
      projectId,
      section: sectionLabel,
      threshold,
      narrative: section?.narrative ?? false,
      reconstruction: section?.reconstruction ?? false,
      summary: summarizeFaithfulness(result),
    });

    // Pick the warning-copy variant that honestly frames WHY this section fell
    // short, by section character:
    //   - narrative (Overview, Capabilities): "X% grounded; remainder is domain
    //     context" — the gap is general domain knowledge, not a defect.
    //   - reconstruction (Workflows, Data Model): "inferred — verify against
    //     source" — the gap is mandated structural inference, not fabrication.
    //   - literal (Business Rules, Integrations): "may be unreliable" — an
    //     unsupported claim genuinely signals fabrication.
    const warning = buildFaithfulnessWarning(sectionLabel, result, threshold, section);
    return { markdown: sectionMarkdown, warning, score };
  } catch (err) {
    // A faithfulness-scoring failure must NOT crash synthesis. Degrade to the
    // original section with no warning — we cannot assert it is unfaithful, only
    // that we failed to verify it.
    log.warn("Faithfulness scoring failed for section; passing through unverified", {
      projectId,
      section: sectionLabel,
      err: String(err),
    });
    return { markdown: sectionMarkdown, warning: null, score: null };
  }
}

// Exported for #334 escalation tests: the per-section synthesis loop is where
// judge-gated escalation lives, and it is the smallest unit that exercises the
// generate → judge → escalate → keep-better flow deterministically (with fake
// providers + a mocked faithfulness scorer). Not part of the public API surface.
export async function synthesizeFinalDocument(
  facts: ModuleFacts[],
  meta: ProjectMeta,
  docType: DocType,
  title: string,
  // #333 — the Phase-2 routing plan. Under single-provider routing every
  // section resolves to `router.primary`; under hybrid routing each section is
  // routed by tier (narrative → escalation, literal/reconstruction → local).
  router: Phase2Router,
  projectId: string,
  grounding?: GroundingContext,
  onSectionProgress?: OnSectionProgress,
  groundingForSection?: SectionGroundingRetriever,
  graphSummary?: CodeGraphSummary,
  reuse?: { previousManifest?: GeneratedDocVersionManifest; effectiveConfigHash?: string },
): Promise<
  HolisticSynthesisResult & {
    sections: Array<{
      sectionLabel: string;
      sectionIndex: number;
      providerKind: "bedrock" | "local" | "anthropic";
      model: string;
      factsSourceIds: string[];
      groundingSourceIds: string[];
    }>;
    selectedEvidence: GroundingSource[];
    sectionSynthesis?: SectionSynthesis;
    regeneration?: GeneratedDocVersionManifest["regeneration"];
  }
> {
  // #243 — best-effort per-section progress reporting; never breaks synthesis.
  const reportSection = (update: SectionProgressUpdate): void => {
    if (!onSectionProgress) return;
    try {
      onSectionProgress(update);
    } catch {
      // swallow — progress reporting must not affect document output
    }
  };
  // Deduplicate within a repository, never collapse identical expressions across repos.
  const seenExpr = new Set<string>();
  const allFormulas: Array<ExtractedFormula & { repository?: RepositoryIdentity }> = [];
  for (const f of facts) {
    for (const formula of f.formulas) {
      const identity = repositoryPathIdentity(f.repository, formula.expression);
      if (seenExpr.has(identity)) continue;
      seenExpr.add(identity);
      allFormulas.push({ ...formula, repository: f.repository });
    }
  }
  const formulasBlob =
    allFormulas.length > 0
      ? allFormulas
          .slice(0, 80)
          .map(
            (f) =>
              `- ${f.repository ? `[${f.repository.repoConnectorId ?? f.repository.codeGraphId}] ` : ""}${f.kind}: ${f.expression.slice(0, 250)}`,
          )
          .join("\n")
      : "(none extracted)";

  // #271 — project-level end-to-end FLOW block: cross-module dependency/call
  // summary + SAS dataset lineage chain, both derived from the code graph and
  // char-budget bounded (≈8K chars / ~2K tokens max combined). Built ONCE here
  // and injected into every section prompt so "Key Workflows", architecture,
  // and overview sections can describe TRUE cross-module + dataset
  // input→output flows instead of isolated per-module summaries.
  const flowBlob = graphSummary
    ? [renderDatasetLineageChain(graphSummary), renderCrossModuleDeps(graphSummary)]
        .filter((s) => s.length > 0)
        .join("\n\n")
    : "";

  // #333 — offline is a property of the primary (globally-configured) provider;
  // the hybrid local/escalation bundles are only built for online routing, so
  // this preserves the pre-#333 short-circuit exactly.
  if (router.primary.provider.offline) {
    return {
      markdown: renderOfflineDocument(title, docType, meta, facts),
      warnings: [],
      sections: [],
      selectedEvidence: [],
    };
  }

  const groups = sectionGroupsFor(docType);
  const sectionMarkdowns: string[] = [];
  const manifestSections: Array<{
    sectionLabel: string;
    sectionIndex: number;
    providerKind: "bedrock" | "local" | "anthropic";
    model: string;
    factsSourceIds: string[];
    groundingSourceIds: string[];
  }> = [];
  const selectedEvidenceById = new Map<string, GroundingSource>();
  // #1226 — every group that actually contributed markdown, with the H2 heading
  // it led with. Compared against the ASSEMBLED body below so a section the
  // dedupe pass swallows is reported instead of vanishing silently.
  const contributed: Array<{ label: string; heading: string | null }> = [];
  // #225 — collect degraded-output warnings instead of burying failures as
  // silent HTML comments. The caller derives the doc status from these so a
  // doc with a failed section is never reported as a clean `ready`.
  const warnings: DocWarning[] = [];

  // #334 — judge-gated escalation config, read ONCE so a mid-run env change can't
  // shift the budget partway through. `escalationsUsed` is the per-document
  // counter that bounds the total re-runs (and, per-section, the at-most-one
  // guard is structural: each section escalates in a single non-looping branch).
  const escalationConfig = resolveEscalationConfig();
  const sharedEscalationEnabled = escalationConfig.enabled && router.hybrid != null;
  const previousRecords = reusableSectionRecords(
    reuse?.effectiveConfigHash ? reuse.previousManifest?.sectionSynthesis : undefined,
    groups.map((group) => group.id),
    sharedEscalationEnabled,
  );
  const synthesisRecords: SectionSynthesisRecord[] = [];
  const regeneratedSections: string[] = [];
  let reusedCount = 0;
  let escalationsUsed = 0;
  if (escalationConfig.enabled && router.hybrid) {
    log.info("Judge-gated escalation ARMED", {
      projectId,
      docType,
      maxEscalations: escalationConfig.maxEscalations,
      escalationProvider: router.hybrid.escalation.kind,
    });
  }

  // #222/#267 — the grounding block injected into each section prompt is now
  // rendered per-section inside the loop (after facts are merged), so a stale
  // doc-level pre-render is no longer needed here.

  // #223/#224/#273 — the claim extractor + faithfulness judge are provider-
  // specific (each uses ITS bundle's claim/judge model, caching capability, and
  // facts-char budget). Under single-provider routing every section resolves to
  // the same bundle, so these are built once and reused; under hybrid routing a
  // local vs cloud section gets its own extractor/judge. We memoize per bundle
  // so we never rebuild them for two sections that share a provider.
  //
  // The grounding pathway itself is unchanged: a validator is only meaningful
  // when a doc-level context exists OR a per-section retriever is supplied
  // (#264); otherwise we keep the fully-ungrounded path (null extractor).
  const groundingActive = (grounding != null && !grounding.isEmpty) || groundingForSection != null;
  interface SectionGrounder {
    claimExtractor: ClaimExtractor | null;
    faithfulnessJudge: FaithfulnessJudge | null;
  }
  const grounderCache = new Map<Phase2ProviderBundle, SectionGrounder>();
  const grounderFor = (bundle: Phase2ProviderBundle): SectionGrounder => {
    const cached = grounderCache.get(bundle);
    if (cached) return cached;
    // #336 — structured output is a LOCAL/vLLM-only, flag-gated capability
    // (`structuredOutput`, default `off`). Only the local provider's tuning ever
    // sets another mode, so Bedrock/Anthropic bundles pass `undefined` and their
    // requests are byte-for-byte unchanged. #117 — `json_object` for a runtime
    // that accepts `json_schema` and ignores it.
    const mode = bundle.tuning.structuredOutput;
    const claimFormat =
      mode === "json_schema"
        ? CLAIM_DECOMPOSITION_RESPONSE_FORMAT
        : mode === "json_object"
          ? JSON_OBJECT_RESPONSE_FORMAT
          : undefined;
    const judgeFormat =
      mode === "json_schema"
        ? FAITHFULNESS_VERDICTS_RESPONSE_FORMAT
        : mode === "json_object"
          ? JSON_OBJECT_RESPONSE_FORMAT
          : undefined;
    // #1226 — the grounders run a DIFFERENT model than the Phase-2 section
    // model the bundle's provider was built for, so each must carry its own
    // cap. Inheriting the provider's `defaultMaxTokens` would ask a Haiku-class
    // claim/judge model for a section-sized budget it rejects outright.
    const claimExtractor = groundingActive
      ? new ClaimExtractor({
          provider: bundle.provider,
          model: bundle.tuning.claimModel,
          promptCaching: bundle.supportsCaching,
          maxTokens: resolveSectionMaxOutputTokens(bundle.tuning.claimModel),
          ...(claimFormat ? { responseFormat: claimFormat } : {}),
        })
      : null;
    // #anthropic-prompt-caching — when the provider supports caching, the judge
    // caches the SOURCE EVIDENCE prefix identical across every per-claim batch
    // of a section (the single biggest doc-gen cache win).
    const faithfulnessJudge = claimExtractor
      ? new FaithfulnessJudge({
          provider: bundle.provider,
          model: bundle.tuning.judgeModel,
          charBudget: bundle.factsCharCap,
          promptCaching: bundle.supportsCaching,
          maxTokens: resolveSectionMaxOutputTokens(bundle.tuning.judgeModel),
          ...(judgeFormat ? { responseFormat: judgeFormat } : {}),
        })
      : null;
    const grounder: SectionGrounder = { claimExtractor, faithfulnessJudge };
    grounderCache.set(bundle, grounder);
    return grounder;
  };

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const warningStart = warnings.length;
    log.info("Generating section group", {
      projectId,
      docType,
      group: group.id,
    });
    // #243 — announce this section is now generating (live per-section status).
    reportSection({
      section: group.label,
      status: "generating",
      index: gi + 1,
      total: groups.length,
    });
    try {
      // #333 — select THIS section's Phase-2 provider by tier. Under
      // single-provider routing every section resolves to `router.primary`
      // (unchanged); under hybrid routing narrative → escalation (Sonnet),
      // literal/reconstruction → local. Everything below (generation, the
      // citable facts budget, claim extraction, and the faithfulness judge)
      // uses THIS bundle, so a local vs cloud section stays independently tuned.
      const { bundle, tier } = providerForSection(router, group);
      const { provider, supportsCaching, factsCharCap, tuning } = bundle;
      const { claimExtractor, faithfulnessJudge } = grounderFor(bundle);
      const sectionFactsSources: FactsSourceInput[] = buildSectionFactsSources(
        facts,
        group,
        docType,
        factsCharCap,
      );
      const factsSourceIds = sectionFactsSources.map(
        (source) =>
          `facts:${source.repository ? repositoryPathIdentity(source.repository, source.moduleDir) : source.moduleDir}:${source.idx}`,
      );
      if (router.hybrid) {
        log.info("Routed section to provider", {
          projectId,
          docType,
          group: group.id,
          tier,
          provider: bundle.kind,
          model: tuning.phase2Model,
        });
      }
      // #264 — resolve THIS section's grounding. When a per-section retriever
      // is supplied, retrieve sources for the section's topic query (label +
      // keywords + doc title); otherwise fall back to the doc-level context.
      // A retriever that returns undefined also falls back, preserving the
      // single-retrieval back-compat path.
      let sectionGrounding = grounding;
      if (groundingForSection) {
        try {
          const retrieved = await groundingForSection({
            id: group.id,
            query: buildSectionTopicQuery(group, title),
          });
          if (retrieved) sectionGrounding = retrieved;
        } catch (err) {
          // Retrieval is best-effort; fall back to the doc-level context.
          log.warn("Per-section grounding retrieval failed; using doc-level grounding", {
            projectId,
            section: group.id,
            err: String(err),
          });
        }
      }
      // Build a relevance-scored facts blob tailored to this section group.
      // `factsCharCap` is the provider-optimized budget resolved upstream
      // (large for Bedrock, small for local-gemma's 32K window) so each
      // provider stays independently tuned. #108.
      const factsBlob = buildRelevantFactsBlob(facts, group, docType, factsCharCap);

      // #337 — make facts-cap truncation OBSERVABLE. `buildRelevantFactsBlob`
      // silently drops the lowest-ranked modules when the relevant facts exceed
      // `factsCharCap` (it only appends a compact "ADDITIONAL MODULES" catalog).
      // On the LOCAL provider (small ~32K window) an over-cap facts blob risks
      // context-shift → the runtime drops the instructions → an empty/degraded
      // section with no clear cause. So: ALWAYS log the budget outcome for
      // telemetry, and on the LOCAL path raise a `facts-truncated` DocWarning so
      // `deriveDocStatus` marks the doc `degraded` and the operator sees the
      // concrete remedy (raise the cap / narrow retrieval). Large-window
      // providers (Bedrock ~200K) omit tail modules by design → log only, no
      // warning (avoids false-flagging every big-project cloud run).
      const factsBudget = summarizeFactsBudget(facts, group, docType, factsCharCap);
      if (factsBudget.exceeded) {
        log.warn("Section facts exceeded the facts char cap — modules omitted", {
          projectId,
          docType,
          section: group.id,
          provider: bundle.kind,
          factsCharCap,
          includedModules: factsBudget.includedModules,
          omittedModules: factsBudget.omittedModules,
          includedChars: factsBudget.includedChars,
        });
        if (bundle.kind === "local") {
          warnings.push(
            factsTruncatedWarning(
              group.label,
              factsBudget.omittedModules,
              factsBudget.includedModules,
              factsCharCap,
            ),
          );
        }
      }

      // #267 — admit THIS section's selected module facts as citable `facts:`
      // grounding sources, merged into the SAME context used for both generation
      // and validation. Docs are synthesized FROM these facts, but the validator
      // could previously only resolve rag:/web: ids, so fact-derived claims had
      // nothing to cite and were flagged ungrounded. Merging facts (first, ahead
      // of rag/web) lets those claims resolve.
      //
      // Gated on an ACTIVE grounding pathway (`claimExtractor != null`, i.e. a
      // doc-level grounding context OR a per-section retriever was supplied): a
      // caller that opted out of grounding entirely keeps the fully-ungrounded
      // path (no grounding block, no validation) — back-compat preserved.
      if (claimExtractor) {
        // Pass `factsCharCap` so the CITABLE facts budget matches the facts BLOB
        // the model actually read (`buildRelevantFactsBlob` above used the same
        // cap). Without it, mergeFactsIntoContext fell back to its 60K default
        // and silently dropped the >60K Bedrock tail from the citable set —
        // those fact-derived claims could not cite → were stripped → section
        // `degraded` (the exact #267 regression, re-introduced for the tail).
        // Base RAG/web sources are preserved regardless (see mergeFactsIntoContext).
        sectionGrounding = mergeFactsIntoContext(
          sectionGrounding,
          sectionFactsSources,
          factsCharCap,
        );
      }

      const groundingBlock = sectionGrounding ? renderGroundingBlock(sectionGrounding) : "";
      const prompts = buildSectionPrompts(
        group,
        meta,
        title,
        docType,
        factsBlob,
        formulasBlob,
        tuning,
        groundingBlock,
        flowBlob,
      );
      const inputHashes = hashSectionInputs({
        facts: factsBlob,
        formulas: formulasBlob,
        flow: flowBlob,
        grounding: JSON.stringify({
          block: groundingBlock,
          sources: sectionGrounding?.sources ?? [],
          sourceIds: [...(sectionGrounding?.sourceIds ?? [])],
          isEmpty: sectionGrounding?.isEmpty ?? true,
          active: groundingActive,
        }),
        context: JSON.stringify({ projectId, title, meta, group, docType, index: gi, factsBudget }),
        config: JSON.stringify({
          version: SECTION_SYNTHESIS_VERSION,
          effective: reuse?.effectiveConfigHash,
          provider: { key: provider.key, model: provider.model, kind: bundle.kind },
          tuning,
          supportsCaching,
          factsCharCap,
          escalationConfig,
          sectionMaxTokens: resolveSectionMaxOutputTokens(provider.model),
          claimMaxTokens: resolveSectionMaxOutputTokens(tuning.claimModel),
          judgeMaxTokens: resolveSectionMaxOutputTokens(tuning.judgeModel),
          judgeMaxBatch: DEFAULT_JUDGE_MAX_BATCH,
          judgeMinBatchMatchRatio: MIN_BATCH_MATCH_RATIO,
          structuredSchemas:
            tuning.structuredOutput === "off"
              ? null
              : [CLAIM_DECOMPOSITION_RESPONSE_FORMAT, FAITHFULNESS_VERDICTS_RESPONSE_FORMAT],
          threshold: resolveSectionFaithfulnessThreshold(group.faithfulnessThreshold),
        }),
        prompts: JSON.stringify(prompts),
      });
      const previous = previousRecords.get(group.id);
      if (previous && JSON.stringify(previous.inputs) === JSON.stringify(inputHashes)) {
        sectionMarkdowns.push(previous.markdown);
        manifestSections.push(previous.metadata);
        // Grounding was freshly retrieved and hashed above, so these are the
        // exact sources whose metadata/evidence accompanied the saved output.
        for (const source of sectionGrounding?.sources ?? []) {
          if (!selectedEvidenceById.has(source.sourceId))
            selectedEvidenceById.set(source.sourceId, source);
        }
        contributed.push({ label: group.label, heading: firstH2Heading(previous.markdown) });
        warnings.splice(warningStart);
        warnings.push(...previous.warnings);
        synthesisRecords.push(previous);
        reusedCount += 1;
        reportSection({
          section: group.label,
          status: previous.warnings.length ? "degraded" : "done",
          index: gi + 1,
          total: groups.length,
          warning: previous.warnings[0],
        });
        continue;
      }
      regeneratedSections.push(group.id);
      const generated = await generateSectionGroup(
        group,
        meta,
        title,
        docType,
        factsBlob,
        formulasBlob,
        provider,
        supportsCaching,
        projectId,
        tuning,
        groundingBlock,
        flowBlob,
      );
      const md = generated.markdown;
      // #1226 — the truncation verdict travels with whichever output is KEPT
      // below (local draft vs escalated re-run), so the warning always describes
      // the text that actually reaches the document.
      let keptTruncation = generated;
      // #273 — post-validate the freshly-synthesized section by ENTAILMENT:
      // decompose it into atomic claims, then judge each claim's support against
      // THIS section's grounding context (the judge sees source TEXT, not ids),
      // scoring RAGAS-style supported/total. A `section-ungrounded` warning is
      // emitted only when faithfulness falls BELOW the threshold — accurate
      // abstractive synthesis (no exact id) is no longer false-flagged. A
      // failure here degrades only this section (a warning), never the whole
      // synthesis — consistent with #225.
      const sectionGating = {
        threshold: group.faithfulnessThreshold,
        narrative: group.narrative,
        reconstruction: group.reconstruction,
      };
      const validated = await validateSectionGrounding(
        group.label,
        md.trim(),
        claimExtractor,
        faithfulnessJudge,
        sectionGrounding,
        projectId,
        // #283 — per-section gating carried on the group definition.
        sectionGating,
      );

      // #334 — judge-gated escalation (quality floor). When a LOCAL section
      // scored strictly below its tier threshold (and hybrid routing + an
      // escalation provider are available and the per-document budget is not
      // spent), re-run the SAME section ONCE on the escalation (Sonnet) provider
      // and keep whichever output scores higher. `generateSectionGroup` records
      // token usage keyed by the escalation provider, so the cloud re-run's cost
      // flows into `AITokenUsage` automatically. This branch never loops: it
      // fires at most once per section and consumes one unit of budget.
      let finalOutcome = validated;
      let finalBundle = bundle;
      let finalGrounding = sectionGrounding;
      if (
        shouldEscalateSection({
          config: escalationConfig,
          router,
          sectionBundle: bundle,
          score: validated.score,
          escalationsUsed,
        })
      ) {
        escalationsUsed += 1;
        const localScore = validated.score!.faithfulness;
        const esc = router.hybrid!.escalation;
        const escGrounder = grounderFor(esc);
        log.info("Escalating below-threshold local section to cloud provider", {
          projectId,
          docType,
          group: group.id,
          tier,
          localScore,
          threshold: validated.score!.threshold,
          escalationProvider: esc.kind,
          escalationModel: esc.tuning.phase2Model,
          escalationsUsed,
          maxEscalations: escalationConfig.maxEscalations,
        });
        try {
          // Rebuild the facts blob at the ESCALATION provider's (larger) budget
          // and the citable facts/grounding to match — Sonnet can see more than
          // the local window, and its claims must resolve against the same set.
          const escFactsBlob = buildRelevantFactsBlob(facts, group, docType, esc.factsCharCap);
          let escGrounding = sectionGrounding;
          if (escGrounder.claimExtractor) {
            escGrounding = mergeFactsIntoContext(
              escGrounding,
              buildSectionFactsSources(facts, group, docType, esc.factsCharCap),
              esc.factsCharCap,
            );
          }
          const escBlock = escGrounding ? renderGroundingBlock(escGrounding) : "";
          const escMd = await generateSectionGroup(
            group,
            meta,
            title,
            docType,
            escFactsBlob,
            formulasBlob,
            esc.provider,
            esc.supportsCaching,
            projectId,
            esc.tuning,
            escBlock,
            flowBlob,
          );
          const escValidated = await validateSectionGrounding(
            group.label,
            escMd.markdown.trim(),
            escGrounder.claimExtractor,
            escGrounder.faithfulnessJudge,
            escGrounding,
            projectId,
            sectionGating,
          );
          // Keep whichever output scored HIGHER. Ties (or an unverifiable
          // escalated re-run) keep the escalated output — the cloud provider is
          // the quality ceiling, so its result is the safer default. The kept
          // output's warning is whatever ITS own scoring produced, so if the
          // escalated result still falls below the bar the correct tier warning
          // is still surfaced (never a false clean `ready`).
          const escScore = escValidated.score?.faithfulness ?? null;
          const keptEscalated = escScore == null ? true : escScore >= localScore;
          finalOutcome = keptEscalated ? escValidated : validated;
          if (keptEscalated) {
            keptTruncation = escMd;
            finalBundle = esc;
            finalGrounding = escGrounding;
          }
          log.info("Escalation decision", {
            projectId,
            docType,
            group: group.id,
            localScore,
            escalatedScore: escScore,
            kept: keptEscalated ? "escalated" : "local",
            stillBelowThreshold: finalOutcome.warning != null,
          });
        } catch (err) {
          // An escalation re-run failure must never crash synthesis or discard
          // the already-generated local section: keep the local outcome (with its
          // below-threshold warning intact) and move on.
          log.warn("Escalation re-run failed; keeping local section", {
            projectId,
            docType,
            group: group.id,
            err: String(err),
          });
          finalOutcome = validated;
        }
      }

      // A section that came back EMPTY is a silent failure, not a valid result:
      // the model produced no prose at all (e.g. the provider returned a stream
      // carrying zero tokens). Pushing it bare produced a document containing
      // only its title and footer that was still persisted as a clean `ready`
      // with zero warnings — the single most misleading outcome this pipeline
      // can emit, because callers cannot distinguish "nothing to say" from
      // "nothing was generated". Record it as a warning so the document degrades.
      if (finalOutcome.markdown.trim().length === 0) {
        const emptyWarning = sectionFailedWarning(
          group.label,
          "model returned no content (empty section output)",
        );
        log.warn("Section group produced empty markdown", {
          projectId,
          docType,
          group: group.id,
        });
        warnings.push(emptyWarning);
        reportSection({
          section: group.label,
          status: "degraded",
          index: gi + 1,
          total: groups.length,
          warning: emptyWarning,
        });
        manifestSections.push({
          sectionLabel: group.label,
          sectionIndex: gi,
          providerKind: finalBundle.kind,
          model: finalBundle.tuning.phase2Model,
          factsSourceIds,
          groundingSourceIds: finalGrounding?.sources.map((source) => source.sourceId) ?? [],
        });
        continue;
      }

      sectionMarkdowns.push(finalOutcome.markdown);
      for (const source of finalGrounding?.sources ?? []) {
        if (!selectedEvidenceById.has(source.sourceId)) {
          selectedEvidenceById.set(source.sourceId, source);
        }
      }
      manifestSections.push({
        sectionLabel: group.label,
        sectionIndex: gi,
        providerKind: finalBundle.kind,
        model: finalBundle.tuning.phase2Model,
        factsSourceIds,
        groundingSourceIds: finalGrounding?.sources.map((source) => source.sourceId) ?? [],
      });
      contributed.push({ label: group.label, heading: firstH2Heading(finalOutcome.markdown) });
      if (finalOutcome.warning) warnings.push(finalOutcome.warning);
      // #1226 — the section WAS produced but the model was cut off by the
      // output-token cap, so it is incomplete. Record it (error severity) so the
      // document degrades instead of shipping a half-written section as `ready`.
      let truncationWarning: DocWarning | undefined;
      if (keptTruncation.truncation.truncated) {
        truncationWarning = sectionTruncatedWarning(
          group.label,
          describeTruncation(keptTruncation.truncation),
          keptTruncation.maxTokens,
        );
        log.warn("Section group truncated by the output-token cap", {
          projectId,
          docType,
          group: group.id,
          maxTokens: keptTruncation.maxTokens,
          signals: keptTruncation.truncation.signals,
          finishReason: keptTruncation.truncation.reason,
        });
        warnings.push(truncationWarning);
      }
      // #243 — a section with an ungrounded-claims warning is `degraded`, not a
      // clean `done`; surface that live so the UI shows the warning during
      // generation, not after a manual refresh.
      const liveWarning = finalOutcome.warning ?? truncationWarning;
      // A failed/empty section or malformed legacy evidence cannot establish
      // completeness. Never let recording a reuse candidate break generation.
      if (!sharedEscalationEnabled && reuse?.effectiveConfigHash) {
        try {
          synthesisRecords.push(
            recordSectionSynthesis(group.id, inputHashes, {
              markdown: finalOutcome.markdown,
              warnings: warnings.slice(warningStart),
              score: finalOutcome.score,
              metadata: manifestSections[manifestSections.length - 1],
              evidence: (finalGrounding?.sources ?? []).map(({ text, ...source }) => ({
                ...source,
                evidenceClass: source.evidenceClass ?? null,
                contentHash: evidenceContentHash({ text }),
              })),
            }),
          );
        } catch {
          log.warn("Section reuse record incomplete; next synthesis must be full", {
            section: group.id,
          });
        }
      }
      reportSection({
        section: group.label,
        status: liveWarning ? "degraded" : "done",
        index: gi + 1,
        total: groups.length,
        warning: liveWarning ?? undefined,
      });
    } catch (err) {
      if (!regeneratedSections.includes(group.id)) regeneratedSections.push(group.id);
      log.warn("Section group failed", {
        err: String(err),
        group: group.id,
        docType,
      });
      // #225 — surface as a visible, user-facing degraded-output warning. The
      // failed section is omitted from the body (no silent HTML comment) and
      // the document will be marked `degraded`, not a clean `ready`.
      // #67 — through the FIXED failure vocabulary, never `String(err)`. This
      // warning is persisted, returned by `GET /docs/:docId` and rendered in
      // the UI banner, so the raw exception put provider response bodies,
      // server paths and SQL text in front of the user — the same exposure #52
      // closed for a failed document's `errorMessage`. The raw error is in the
      // `log.warn` immediately above, which is where it belongs.
      const failWarning = sectionFailedWarning(group.label, generationFailureMessage(err));
      warnings.push(failWarning);
      // #243 — surface the failed section live, with its warning.
      reportSection({
        section: group.label,
        status: "failed",
        index: gi + 1,
        total: groups.length,
        warning: failWarning,
      });
    }
  }

  // Assemble the final document with title header and footer.
  const header = `# ${title}\n\n> **${docTypeLabel(docType)}** for **${meta.name}** &mdash; auto-generated on ${new Date().toISOString().split("T")[0]}.\n>\n> Synthesized from ${facts.length} modules across ${meta.totalFiles} source files (${meta.totalSymbols.toLocaleString()} code symbols).\n`;

  const footer = `\n\n---\n\n*This ${docTypeLabel(docType).toLowerCase()} document was generated automatically by analyzing the project's source code with an LLM. Verify business-critical details against the original source before relying on them.*\n`;

  // Each section group already starts with its own H2 heading.
  // Defensive dedupe: strip any duplicate H2 sections (can happen if a
  // streaming recap event sneaks past delta dedupe in copilot-provider
  // or if the LLM regenerates content mid-stream). First occurrence of
  // each H2 heading wins.
  const body = dedupeH2Sections(sectionMarkdowns.join("\n\n"));
  // #1226 — a section can survive generation and still not reach the reader:
  // `dedupeH2Sections` keeps only the FIRST block per H2 heading, so two groups
  // that happened to lead with the same heading collapse into one and the
  // second disappears with no warning at all. Verify the assembled body against
  // what each group contributed and report anything that went missing.
  for (const warning of detectMissingSections(contributed, body)) {
    log.warn("Section missing from assembled document", {
      projectId,
      docType,
      section: warning.section,
    });
    warnings.push(warning);
  }
  // #1360 — last, so heading matching above sees exactly what each group produced.
  const readableBody = stripLeakedSourceIds(body);
  return {
    markdown: `${header}\n${readableBody}${footer}`,
    warnings,
    sections: manifestSections,
    selectedEvidence: [...selectedEvidenceById.values()],
    ...(synthesisRecords.length === groups.length
      ? {
          sectionSynthesis: {
            version: SECTION_SYNTHESIS_VERSION,
            complete: true,
            records: synthesisRecords,
          },
        }
      : {}),
    regeneration:
      reusedCount === groups.length
        ? { mode: "unchanged", changed: [] }
        : reusedCount > 0
          ? { mode: "sections", changed: regeneratedSections, sections: regeneratedSections }
          : {
              mode: "full",
              changed: regeneratedSections,
              reason: sharedEscalationEnabled
                ? "Shared hybrid escalation budget requires full synthesis"
                : previousRecords.size === 0
                  ? "Complete section synthesis records unavailable"
                  : "All section synthesis inputs changed",
            },
  };
}

/**
 * The first `## Heading` text in a section's markdown, or `null` when it has
 * none. Fenced code blocks are skipped so a `## comment` inside a code sample
 * is never mistaken for a heading (same rule `dedupeH2Sections` applies).
 */
export function firstH2Heading(markdown: string): string | null {
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Every `## Heading` present in assembled markdown, in document order and
 * INCLUDING repeats, outside code fences. Repeats matter: two section groups
 * that lead with the same heading collapse into one block during assembly, and
 * only a count (not set membership) reveals that one of them was dropped.
 */
export function collectH2Headings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) headings.push(match[1]);
  }
  return headings;
}

/**
 * #1226 — report any group whose contributed markdown is not represented in the
 * assembled body. Headings are matched by COUNT, not presence: when two groups
 * both lead with `## Business Rules`, de-duplication keeps only the first block
 * and the second group is gone, even though the heading is still there. A group
 * that contributed no H2 heading at all cannot be located in the assembly, so it
 * is reported too rather than assumed present.
 */
export function detectMissingSections(
  contributed: ReadonlyArray<{ label: string; heading: string | null }>,
  body: string,
): DocWarning[] {
  const remaining = new Map<string, number>();
  for (const heading of collectH2Headings(body)) {
    remaining.set(heading, (remaining.get(heading) ?? 0) + 1);
  }
  const missing: DocWarning[] = [];
  for (const entry of contributed) {
    if (entry.heading === null) {
      missing.push(
        sectionMissingWarning(
          entry.label,
          "the generated section had no '##' heading, so it cannot be located in the assembled document",
        ),
      );
      continue;
    }
    const left = remaining.get(entry.heading) ?? 0;
    if (left > 0) {
      // Claim one occurrence — a later group with the same heading will find
      // none left and be correctly reported as dropped.
      remaining.set(entry.heading, left - 1);
      continue;
    }
    missing.push(
      sectionMissingWarning(
        entry.label,
        `its heading "${entry.heading}" is not present in the assembled document (a duplicate heading was collapsed during de-duplication)`,
      ),
    );
  }
  return missing;
}

/**
 * #1360 — remove internal grounding source ids that leaked into rendered prose.
 *
 * Each grounding source is shown to the model labelled `id=facts:…` so it can be
 * cited STRUCTURALLY (the faithfulness judge returns `sourceIds`; the provenance
 * manifest records them). Nothing ever asks the model to write those ids into the
 * document, but it copies them anyway — 1,427 such markers across 11 real
 * generated documents when this was measured.
 *
 * #1354 made it materially worse: repository-scoped ids are a URL-encoded JSON
 * array, chosen so two repositories sharing a module directory name cannot
 * collide. That identity is correct and must not be shortened — it simply must
 * not reach the reader, where it renders as a 130-character blob.
 *
 * Deliberately conservative: only a bracket whose content begins with a known
 * grounding prefix is removed, one optional leading space goes with it, and
 * fenced code blocks are left alone (same rule {@link dedupeH2Sections}
 * follows). No general whitespace normalisation — that would wreck table
 * alignment and indented code.
 *
 * #1370 — `[facts:…]` was never the only family. `[rag:<cuid>:<cuid>]` pairs
 * leak from retrieval context and were measured at 328 markers across 13
 * documents — MORE documents than the `[facts:…]` family this stripper was
 * originally written for. Both are matched here by one prefix alternation so a
 * third family only ever needs a new entry in {@link LEAKED_ID_PREFIXES}.
 *
 * Runs at ASSEMBLY, after claim extraction and faithfulness judging, so grounding
 * scores are computed on exactly what the model wrote.
 */
const LEAKED_ID_PREFIXES = ["facts", "rag"] as const;

/**
 * ` [facts:…]` / ` [rag:…]` — no nested `]`, so it cannot span a link label.
 *
 * The closing bracket is OPTIONAL because the model truncates: three markers in
 * the real corpus end at a line break with no `]` at all (one mid-way through a
 * percent-encoded repository identity). Requiring the bracket left those
 * rendered verbatim in prose and in Markdown export. Anchoring the unterminated
 * case to end-of-line keeps it from swallowing the rest of the document.
 */
const LEAKED_ID_RE = new RegExp(
  ` ?\\[\\s*(?:${LEAKED_ID_PREFIXES.join("|")}):[^\\]\\n]*(?:\\]|$)`,
  "g",
);

export function stripLeakedSourceIds(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(LEAKED_ID_RE, "");
    })
    .join("\n");
}

/** True when `text` still carries at least one leaked grounding marker. */
export function hasLeakedSourceIds(text: string): boolean {
  return text !== stripLeakedSourceIds(text);
}

/**
 * Strip duplicate `## Heading` blocks from assembled markdown. First
 * occurrence wins; subsequent copies (including all content until the
 * next unique H2 or end-of-document) are discarded. Headings inside
 * fenced code blocks are not touched.
 */
function dedupeH2Sections(markdown: string): string {
  const lines = markdown.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  let inFence = false;
  let skipping = false;

  for (const line of lines) {
    if (/^`{3,}/.test(line)) {
      inFence = !inFence;
      if (!skipping) out.push(line);
      continue;
    }
    if (!inFence && /^## /.test(line)) {
      const heading = line.replace(/^## /, "").trim().toLowerCase();
      if (seen.has(heading)) {
        skipping = true;
        continue;
      }
      seen.add(heading);
      skipping = false;
      out.push(line);
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

// ============================================================================
// Phase-2 fact selection (#154) — what each section reads
// ============================================================================
//
// These four functions are the ONE place that decides which module facts a
// section sees, and they must stay in lock-step: the facts BLOB the model reads
// (buildRelevantFactsBlob), the citable `facts:` grounding SOURCES its claims
// are judged against (buildSectionFactsSources), and the budget telemetry that
// raises `facts-truncated` (summarizeFactsBudget) are all built from the same
// selectRelevantFacts result and the same per-module entry (factsModuleEntry).
// Anything that changes what a section reads — batching (#157) included —
// should go through selectRelevantFacts + factsModuleEntry rather than render
// module facts itself, or the model and the judge will see different text.

/**
 * The fact slices each section group reads when it does not declare its own
 * (#154). {@link sectionGroupsFor} declares these on every group; the map is the
 * single source for both, and also covers ad-hoc groups built from an id.
 * A group id missing from the map reads every slice (the pre-#154 behaviour).
 *
 * Keyed by the CURRENT section-group ids — an earlier keyword map was keyed by
 * long-removed ids and silently fell through to a default for every section.
 * Keep in lock-step with {@link SECTION_TOPIC_KEYWORDS} (same ids).
 */
const SECTION_FACT_SLICES: Record<string, readonly FactSlice[]> = {
  // business-requirements
  overview: ["summary", "entities", "integrations"],
  capabilities: ["summary", "capabilities", "workflows", "entities"],
  rules: ["summary", "rules"],
  workflows: ["summary", "workflows"],
  formulas: ["summary", "formulas"],
  "data-model": ["summary", "entities", "capabilities"],
  "integrations-and-glossary": ["summary", "integrations", "capabilities", "entities"],
  // architecture
  "overview-and-context": ["summary", "integrations", "capabilities", "notes"],
  "components-and-data": ["summary", "entities", "capabilities", "integrations"],
  "concerns-and-integrations": ["summary", "integrations", "capabilities", "rules", "notes"],
  "ops-and-stack": ["summary", "formulas", "integrations", "notes"],
  // user-guide
  intro: ["summary", "entities", "workflows"],
  tasks: ["summary", "workflows", "capabilities", "rules"],
  "rules-and-calcs": ["summary", "rules", "formulas"],
  "faq-and-glossary": ["summary", "entities", "rules", "notes"],
};

/** Section ids that also receive every module's mined-rule inventory (#155). */
const SECTION_READS_MINED_RULES: ReadonlySet<string> = new Set(["rules", "rules-and-calcs"]);

/** The slices a section group reads: its declaration, else the id map, else all. */
export function factSlicesFor(group: SectionGroup): readonly FactSlice[] {
  return group.factSlices ?? SECTION_FACT_SLICES[group.id] ?? FACT_SLICES;
}

/** Whether a section group receives the deterministic mined-rule inventory. */
export function readsMinedRules(group: SectionGroup): boolean {
  return group.minedRules ?? SECTION_READS_MINED_RULES.has(group.id);
}

/** Parsed slices per facts object, so a blob is split once per run, not per section. */
const sliceCache = new WeakMap<ModuleFacts, { text: string; slices: ModuleFactSlices }>();

/** The topic slices of one module's facts (memoised on the facts object + text). */
export function moduleFactSlices(f: ModuleFacts): ModuleFactSlices {
  const cached = sliceCache.get(f);
  if (cached && cached.text === f.facts) return cached.slices;
  const slices = sliceModuleFacts(f.facts);
  sliceCache.set(f, { text: f.facts, slices });
  return slices;
}

/**
 * Build the facts blob a section group reads (#154): the modules chosen by
 * {@link selectRelevantFacts}, each rendered with ONLY the slices the group
 * declares ({@link factSlicesFor}) — plus, for the Rules sections, the module's
 * mined-rule inventory. A compact catalog names the modules that did not fit
 * `perSectionCap`, so Phase 2 knows they exist.
 *
 * Sending slices instead of whole blobs is what lets most of a large codebase
 * reach a section: onyourleft's Rules section read 8 of 143 modules at 200K
 * chars with whole blobs.
 */
export function buildRelevantFactsBlob(
  facts: ModuleFacts[],
  group: SectionGroup,
  docType: DocType,
  perSectionCap = 150_000,
): string {
  const { included, omitted } = selectRelevantFacts(facts, group, docType, perSectionCap);

  const parts: string[] = included.map((f) => factsModuleEntry(f, group));

  // Append a compact catalog of omitted modules so Phase 2 knows they exist.
  if (omitted.length > 0) {
    parts.push(
      `### ADDITIONAL MODULES (facts omitted due to context budget — ${omitted.length} modules)\n${omitted.map((n) => `- ${n}`).join("\n")}`,
    );
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Issue #337 — summarize how a section's relevance-ranked module facts fit (or
 * did not fit) the provider's per-section `factsCharCap`. Pure and side-effect
 * free (reuses {@link selectRelevantFacts}, the SAME selection the facts blob
 * and citable sources are built from), so the truncation guard is unit-testable
 * without running synthesis. Measured on the section's SLICED entries (#154),
 * so `facts-truncated` reports what this section actually could not fit.
 *
 * `exceeded` is true when at least one relevant module was dropped to fit the
 * cap — i.e. the facts blob the model reads is a strict subset of the relevant
 * facts. On the LOCAL provider (small ~32K window) that is a real grounding-
 * degradation signal the caller surfaces as a `facts-truncated` DocWarning;
 * on large-window providers (Bedrock) tail omission is by design and only logged.
 */
export interface FactsBudgetSummary {
  /** Modules that fit the cap and were sent to the model. */
  includedModules: number;
  /** Relevant modules dropped to fit the cap. */
  omittedModules: number;
  /** Total chars of the included module facts entries. */
  includedChars: number;
  /** The per-section char cap the selection was capped to. */
  factsCharCap: number;
  /** True when at least one relevant module was omitted to fit the cap. */
  exceeded: boolean;
}

export function summarizeFactsBudget(
  facts: ModuleFacts[],
  group: SectionGroup,
  docType: DocType,
  factsCharCap: number,
): FactsBudgetSummary {
  const { included, omitted } = selectRelevantFacts(facts, group, docType, factsCharCap);
  const includedChars = included.reduce((sum, f) => sum + factsModuleEntry(f, group).length, 0);
  return {
    includedModules: included.length,
    omittedModules: omitted.length,
    includedChars,
    factsCharCap,
    exceeded: omitted.length > 0,
  };
}

/**
 * The rendered facts entry for one module AS A GIVEN SECTION READS IT — shared
 * by the blob, the citable facts sources and the budget, so all three agree.
 *
 * Only the group's declared slices are included, in {@link FACT_SLICES} order.
 * A group that reads the Rules slice and mined rules (#155) also gets the
 * module's deterministic inventory, with LLM rule bullets that restate a mined
 * rule removed so no rule is listed twice. A module whose sliced entry is empty
 * for this section (it says nothing on the topic) still renders its header.
 */
function factsModuleEntry(f: ModuleFacts, group: SectionGroup): string {
  const header = `### MODULE: ${f.moduleName}\n(${f.classCount} classes, ${f.methodCount} methods)`;
  const slices = moduleFactSlices(f);
  const wanted = new Set(factSlicesFor(group));
  const mined = readsMinedRules(group) ? (f.minedRules ?? []) : [];
  const body: string[] = [];
  for (const slice of FACT_SLICES) {
    if (!wanted.has(slice) || !slices[slice]) continue;
    body.push(slice === "rules" ? dedupeRulesAgainstMined(slices.rules, mined) : slices[slice]);
  }
  const inventory = renderMinedRuleInventory(mined, MINED_RULES_ENTRY_CHAR_CAP);
  if (inventory) body.push(inventory);
  return body.length > 0 ? `${header}\n\n${body.join("\n\n")}` : header;
}

/**
 * #267 — build citable `facts:` grounding sources for the modules selected for
 * THIS section. One source PER selected module; the text is the SAME rendered
 * module-facts entry the model was given (`factsModuleEntry`, sliced for this
 * group — #154), so a claim derived from those facts resolves against an
 * admitted source, and a mined rule's `file:line` (#155) is part of that text.
 * `idx` is the module's 0-based RANK in this section's relevance-sorted
 * selection (NOT a per-fact-within-module index) — the same rank used to lay out
 * the facts blob, so blob and citable id stay in lock-step within the run. The
 * same module can therefore get a different idx (hence a different id) in a
 * different section, each of which runs its own `selectRelevantFacts`. Returns
 * [] when there are no facts (back-compat).
 */
export function buildSectionFactsSources(
  facts: ModuleFacts[],
  group: SectionGroup,
  docType: DocType,
  perSectionCap = 150_000,
): FactsSourceInput[] {
  const { included } = selectRelevantFacts(facts, group, docType, perSectionCap);
  return included.map((f, idx) => ({
    repository: f.repository,
    moduleDir: f.modulePath || f.moduleName,
    idx,
    label: f.moduleName,
    text: factsModuleEntry(f, group),
  }));
}

/**
 * Score + select the modules most relevant to a section group, capped by char
 * budget. Returns the ordered included modules plus the names of those omitted.
 *
 * Relevance (#154) is measured on the slices the group reads: two points per
 * bullet plus up to ten for length, per slice (`summary` is not scored unless it
 * is all the group reads — every module has one), plus one point per mined rule
 * for a group that reads them, plus half a point per method. Modules are then
 * admitted greedily in score order while their SLICED entry fits
 * `perSectionCap`; a module that does not fit is skipped, not a stopping point,
 * so a smaller module further down can still get in.
 *
 * #157 (batched synthesis) should consume this ordering rather than re-rank.
 */
export function selectRelevantFacts(
  facts: ModuleFacts[],
  group: SectionGroup,
  _docType: DocType,
  perSectionCap = 150_000,
): { included: ModuleFacts[]; omitted: string[] } {
  const declared = factSlicesFor(group);
  const scoredSlices = declared.length > 1 ? declared.filter((s) => s !== "summary") : declared;
  const withMined = readsMinedRules(group);

  const scored = facts.map((f) => {
    const slices = moduleFactSlices(f);
    let score = 0;
    for (const slice of scoredSlices) {
      const content = slices[slice];
      if (!content) continue;
      score += countFactBullets(content) * 2;
      score += Math.min(content.length / 200, 10);
    }
    if (withMined) score += f.minedRules?.length ?? 0;
    // Extra weight for modules with many classes/methods (likely more complex).
    score += f.methodCount * 0.5;
    return { facts: f, score };
  });

  // Sort by relevance score descending (stable, so ties keep input order).
  scored.sort((a, b) => b.score - a.score);

  const included: ModuleFacts[] = [];
  const omitted: string[] = [];
  let totalChars = 0;

  for (const { facts: f } of scored) {
    const entry = factsModuleEntry(f, group);
    if (totalChars + entry.length > perSectionCap) {
      omitted.push(f.moduleName);
      continue;
    }
    included.push(f);
    totalChars += entry.length;
  }

  return { included, omitted };
}

/**
 * Business-requirements section-group ids whose content is DERIVED FROM CODE
 * (Business Rules, Workflows, Calculations, Data Model, Integrations) rather than
 * abstractive domain narrative (`overview`, `capabilities`). These are gated at
 * the code-fidelity faithfulness bar, so every factual claim must trace to the
 * provided facts/sources. They receive the {@link CODE_DERIVED_GROUNDING_GUIDANCE}
 * cite-or-omit instruction; narrative sections deliberately do not.
 */
const CODE_DERIVED_SECTION_IDS = new Set<string>([
  "rules",
  "workflows",
  "formulas",
  "data-model",
  "integrations-and-glossary",
]);

/**
 * Cite-or-omit guidance appended to the system prompt of code-derived sections.
 *
 * Two genuine over-claim patterns observed in the SAS `risk` baseline are
 * addressed here at GENERATION time (cheaper + more honest than stripping
 * afterwards):
 *   1. File-level METADATA stated as business fact — source modification dates
 *      ("dated 25AUG08"), author names/initials ("author DA"), raw program
 *      filenames ("X.SAS") — none of which is business logic and none of which
 *      the faithfulness judge can ground in domain evidence.
 *   2. World-knowledge claims the facts/sources do not establish.
 *
 * It is "ground or OMIT" — it must NOT instruct the model to fabricate citations
 * or invent sources; a claim it cannot support should simply be left out.
 *
 * It ALSO mandates inline PROVENANCE marking: a statement that is a reasonable
 * inference/reconstruction from the evidence (rather than directly stated) is kept
 * but tagged `_(inferred)_`, so the reader (and a future UI) can tell verified
 * facts from inferred ones at a glance. This is the honest middle between "stated
 * → keep unmarked" and "unsupported → omit", and matches what the model already
 * does ad hoc on SAS docs ("[Inferred — metadata only]") — made consistent.
 */
const CODE_DERIVED_GROUNDING_GUIDANCE = `GROUNDING DISCIPLINE (this section is derived from code — every claim must be supported):
- EVERY factual claim you make MUST be supported by the provided MODULE FACTS or RETRIEVED GROUNDING SOURCES. If the facts/sources do not establish a claim, OMIT it — prefer leaving a claim out over stating something the evidence does not support. Do NOT fill gaps with general world-knowledge.
- Do NOT state source-file METADATA as business facts: never assert a source file's modification/revision DATE, its AUTHOR name or initials, or a raw program/FILENAME (e.g. "PROG.SAS"). These are not business logic. Describe what the code DOES, not the file it lives in.
- MARK INFERENCES: when you include a statement that is a reasonable INFERENCE or RECONSTRUCTION from the evidence rather than something it states directly, mark it inline by ending that sentence with _(inferred)_. This lets readers distinguish verified facts from inferred ones. Reserve it for genuine inferences — do NOT tag statements the evidence states outright, and do NOT use it as a license to keep claims you cannot support (those are still OMITted).
- This is "ground or omit", NOT "invent a citation": never fabricate a source id or attribute a claim to evidence that does not contain it.`;

/**
 * One generated section group: its markdown plus whether the model was cut off
 * by the output-token cap (#1226). The caller turns `truncation` into a
 * user-visible warning so a half-written section can never ship as `ready`.
 */
export interface SectionGroupResult {
  markdown: string;
  truncation: TruncationDetection;
  maxTokens: number;
}

function buildSectionPrompts(
  group: SectionGroup,
  meta: ProjectMeta,
  title: string,
  docType: DocType,
  factsBlob: string,
  formulasBlob: string,
  tuning: DocsGenTuning,
  groundingBlock = "",
  flowBlob = "",
): { systemMessage: string; userMessage: string } {
  // The VERBOSE prompt (with explicit EXHAUSTIVE / word-count / table mandates)
  // is the default for ALL providers because it produces markedly more detailed
  // documentation. A concise variant exists for terse summaries but is opt-in
  // (DOCS_GEN_LOCAL_CONCISE_PROMPT) — earlier testing showed it roughly HALVED
  // the output detail and dropped tables, which is the opposite of what an
  // exhaustive doc needs. #117.
  const verboseSystemMessage = `You are a senior technical writer producing one section group of a larger ${docTypeLabel(docType)} document titled "${title}". You will receive structured facts extracted from many modules of a software system. Your job is to write ONLY the section group described below, in polished, RICHLY-FORMATTED GitHub-Flavored Markdown.

CRITICAL MANDATE: Be EXHAUSTIVE. This is production documentation that developers, business analysts, and users will rely on as their single source of truth. Every rule, every validation, every workflow step, every formula MUST be documented. If facts mention a check or threshold, it MUST appear in your output. Shallow, overview-level output is UNACCEPTABLE.

ABSOLUTE RULES:
1. Output ONLY the markdown for this section group. No preamble, no closing remarks, no "I'll write...". Start directly with the first H2 heading specified in the instructions.
2. Do NOT include the document title (no H1). Do NOT include sections outside this group's instructions — they are written separately.
3. Use rich Markdown formatting throughout. The output is rendered with full GFM + Tailwind Typography:
   • **H2** (\`##\`) for major sections, **H3** (\`###\`) for sub-sections, **H4** (\`####\`) for granular topics.
   • **Bold** (\`**text**\`) for key terms, names, and emphasis.
   • Bullet lists (\`- \`) for parallel items; numbered lists (\`1. \`) for ordered steps.
   • **Tables** (GFM pipe syntax) for any structured comparison: rules with conditions/actions, fields with types/descriptions, roles with permissions, etc. Always include a header row.
   • **Blockquote callouts** for important notes:
     > **Note:** Important context.
     > **Warning:** Caveat or risk.
     > **Tip:** Helpful guidance.
   • **Inline code** (\`backticks\`) for entity names, fields, codes, types, and short technical strings.
   • **Fenced code blocks** with a language tag for any sample code or config (\`\`\`java, \`\`\`json, etc).
   • **Horizontal rules** (\`---\`) to separate top-level groups within a long section.
4. For diagrams, include a Mermaid block (\`\`\`mermaid ... \`\`\`). Keep diagrams simple and readable (max ~12 nodes). Use the most appropriate diagram type for each situation:
   • \`graph LR\` / \`graph TB\` — actor maps, dependency graphs, system context
   • \`flowchart TD\` — decision/branching workflows
   • \`sequenceDiagram\` — interaction over time between actors/systems
   • \`erDiagram\` — entity relationships (data model)
   • \`classDiagram\` — class/type structure
   IMPORTANT: every Mermaid block MUST be properly closed with a trailing \`\`\`. Never let a diagram bleed into prose.
   CRITICAL MERMAID LABEL RULES (violations cause empty/broken nodes in the browser):
   - NEVER use \`<\`, \`>\`, \`&\`, \`"\` or \`:\` (colon) inside node labels or edge labels — they break HTML rendering or cause Mermaid to drop the label entirely.
     BAD:  \`H{Retry Count < Max?}\` / \`A[Update State: SUCCESS]\` → render as empty boxes.
     GOOD: \`H{Retry exceeds Max}\` / \`A[Update State SUCCESS]\`  or  \`A["Update State: SUCCESS"]\`
   - For comparisons use plain words: "less than", "greater than", "and", "or".
   - For colons, either omit them or wrap the ENTIRE label in double-quotes: \`A["key: value"]\`.
   - If you must use any of \`< > & " :\`, wrap the ENTIRE label in double-quotes: \`A["label with : colon"]\`.
   - Do NOT add a semicolon after the diagram type declaration (\`graph TD\` not \`graph TD;\`).
5. For math/formulas, use \`$inline$\` and \`$$display$$\` LaTeX syntax. Always include 1-2 sentences explaining what each variable means.
   CRITICAL MATH RULE: The closing \`$$\` of a display formula MUST be on its own line with a blank line after it before any prose resumes. Never put text, bold markers, or anything else on the same line as the closing \`$$\`. Correct example:
   $$
   \\text{x} = y
   $$

   Explanation follows here.
   Wrong: \`\\text{x} = y$$ **Variables:**\` — this breaks the LaTeX renderer and turns everything red.
6. Be SPECIFIC — quote actual entity names, thresholds, codes, and rules verbatim from the source facts. Do NOT invent details. If facts are missing for a topic, say so briefly in a callout.
7. Synthesize ACROSS modules — group related concepts. Do NOT enumerate facts module-by-module.
8. Write in flowing prose for narrative sections; use lists/tables where structure aids comprehension. Avoid wall-of-text — break long sections with H3s and visual elements (tables, callouts, diagrams).
9. DEPTH REQUIREMENTS: Each section group should be THOROUGH — aim for 1500-3000 words. Include EVERY rule, EVERY validation, EVERY workflow step found in the facts. Do not summarize or omit details to save space. The document should be complete enough that someone can understand the full system behavior without reading source code.
10. Use H4 headings liberally to organize dense content into scannable sub-topics.

SECTION GROUP TO PRODUCE:
${group.instructions}`;

  const conciseSystemMessage = `You are a senior technical writer. Write ONLY the "${group.label}" section of a ${docTypeLabel(docType)} for "${title}", as GitHub-Flavored Markdown.

RULES:
- Start DIRECTLY with the first \`##\` heading from the instructions below. No preamble, no H1 title, no closing remarks.
- Be specific and COMPLETE: include every rule, threshold, workflow step, and entity present in the facts. Never invent details not in the facts.
- Format richly: \`##\`/\`###\`/\`####\` headings, **bold** key terms, bullet/numbered lists, GFM tables (always a header row), \`inline code\`, and blockquote callouts (\`> **Note:**\`).
- Diagrams: include ONE Mermaid block (\`graph LR\`, \`flowchart TD\`, \`erDiagram\`, or \`sequenceDiagram\`), max ~12 nodes, always closed with a trailing \`\`\`. NEVER put \`<\`, \`>\`, or \`&\` inside node/edge labels — write "less than", "greater than", "and" instead (those characters render as EMPTY boxes).
- Math: use \`$inline$\` / \`$$display$$\`; put the closing \`$$\` on its own line.
- Synthesize ACROSS modules — group related concepts, don't list module-by-module. Avoid wall-of-text.

SECTION TO PRODUCE:
${group.instructions}`;

  const baseSystemMessage = tuning.concisePrompt ? conciseSystemMessage : verboseSystemMessage;
  // #grounding — code-derived sections (Business Rules, Workflows, Calculations,
  // Data Model, Integrations) get the cite-or-omit + no-file-metadata discipline
  // appended; narrative sections (Overview, Capabilities) deliberately do not, as
  // they are mandated to supply domain context the code does not contain.
  const systemMessage = CODE_DERIVED_SECTION_IDS.has(group.id)
    ? `${baseSystemMessage}\n\n${CODE_DERIVED_GROUNDING_GUIDANCE}`
    : baseSystemMessage;

  const userMessage = `Project: **${meta.name}**
Primary language: ${meta.language}
Source files analyzed: ${meta.totalFiles}
Code symbols: ${meta.totalSymbols}
Document title (already rendered as H1, do NOT repeat): "${title}"
Document type: ${docTypeLabel(docType)}
Section group: **${group.label}**

=== EXTRACTED MODULE FACTS ===

${factsBlob}

=== END MODULE FACTS ===

=== FORMULAS/CONSTANTS DETECTED IN SOURCE ===

${formulasBlob}

=== END FORMULAS ===
${
  flowBlob
    ? `\n=== END-TO-END FLOW (cross-module dependencies + SAS dataset lineage, from the code graph) ===\n\n${flowBlob}\n\nUse this to describe TRUE end-to-end workflows: which module hands off to which, and how datasets flow input→output across modules. Do NOT invent flows not supported by this graph.\n\n=== END FLOW ===\n`
    : ""
}${groundingBlock ? `\n${groundingBlock}\n` : ""}
Write the markdown for the **${group.label}** section group now, following the instructions in your system prompt. Begin with the first H2 heading.`;

  return { systemMessage, userMessage };
}

/**
 * #114 — draft attempts for a local section whose stream drops mid-response:
 * the original plus ONE immediate retry with the identical prompt.
 */
export const MID_STREAM_DROP_ATTEMPTS = 2;

async function generateSectionGroup(
  group: SectionGroup,
  meta: ProjectMeta,
  title: string,
  docType: DocType,
  factsBlob: string,
  formulasBlob: string,
  provider: AIProvider,
  supportsCaching: boolean,
  projectId: string,
  tuning: DocsGenTuning,
  groundingBlock = "",
  flowBlob = "",
): Promise<SectionGroupResult> {
  const isLocal = provider.key === "local-gemma";
  const { systemMessage, userMessage } = buildSectionPrompts(
    group,
    meta,
    title,
    docType,
    factsBlob,
    formulasBlob,
    tuning,
    groundingBlock,
    flowBlob,
  );
  const sessionBase = `docs-synth-${projectId}-${docType}-${group.id}`;

  // ── Draft pass ────────────────────────────────────────────────────────────
  // #114 — on the LOCAL provider a connection that drops MID-STREAM (after the
  // first chunk arrived) is retried once, immediately, with the identical
  // prompt: llama-server saves the prompt to its cache when a request is
  // cancelled (`srv prompt_save`), so the retry skips almost all of the prefill
  // that dominated the first attempt. A drop BEFORE the first chunk, a
  // timeout, or any other error is not retried here — re-sending a prompt the
  // runtime never finished processing repeats the whole prefill (#111).
  const draftSessionId = `${sessionBase}-draft-${Date.now()}-${randomBytes(3).toString("hex")}`;
  let draft: SectionStreamResult | undefined;
  for (let attempt = 1; draft === undefined; attempt++) {
    const progress = { chunks: 0 };
    try {
      draft = await streamSectionContent(provider, {
        sessionId: draftSessionId,
        systemMessage,
        userMessage,
        supportsCaching,
        projectId,
        progress,
      });
    } catch (err) {
      if (
        !isLocal ||
        attempt >= MID_STREAM_DROP_ATTEMPTS ||
        progress.chunks === 0 ||
        !isConnectionDropped(err)
      ) {
        throw err;
      }
      log.warn("Local section stream dropped mid-response; retrying once with the same prompt", {
        projectId,
        docType,
        group: group.id,
        chunksBeforeDrop: progress.chunks,
        err: String(err),
      });
    }
  }
  // #1226 — the DRAFT's truncation verdict is the baseline: the refine pass
  // below is opt-in, local-only, and can only ever be accepted when it
  // preserved the draft's content, so it cannot clear a truncated draft. When
  // an accepted refine output is the one KEPT, its own verdict is merged in —
  // the 95%-length guard admits a refine that was itself cut off at the cap.
  let content = cleanSectionMarkdown(draft.text);
  let truncation = draft.truncation;

  // ── Refine pass (#118, opt-in via DOCS_GEN_LOCAL_REFINE) ───────────────────
  // A second low-temperature pass that fixes RENDERING/STRUCTURE issues only —
  // it must NOT shorten or summarize (an earlier "tighten prose" version
  // halved the detail). Never runs for Bedrock; never blocks the doc: any
  // failure or a shorter result falls back to the cleaned draft.
  if (tuning.refine && isLocal && content.length > 0) {
    try {
      const refineSystem = `You are a meticulous technical documentation fixer. You are given one Markdown section. Return the SAME section with ONLY mechanical defects repaired. This is a fix-up pass, NOT an edit.

STRICT RULES:
- PRESERVE EVERY fact, sentence, table row, list item, and code block. Do NOT summarize, shorten, condense, or delete content. Your output MUST be at least as long as the input.
- Do NOT rephrase for style. Do NOT remove "repetition". Leave the prose as-is unless it is grammatically broken or an obviously incomplete sentence.
- FIX ONLY these mechanical problems:
  • Mermaid diagrams: every block closed with a trailing \`\`\`; NO \`<\`, \`>\`, or \`&\` inside node/edge labels (use "less than"/"greater than"/"and"); if a label contains a colon or quotes, wrap the WHOLE label in double quotes, e.g. \`A["Throw: 'bad'"]\`.
  • Close any unterminated code fences (\`\`\`) or display-math blocks (\`$$\`).
  • Remove a stray duplicate \`##\` heading if the exact same heading appears twice.
  • Complete a sentence that was obviously cut off mid-word.
Output ONLY the corrected Markdown, starting with its first \`##\` heading. No preamble, no commentary.`;
      const refineUser = `Fix mechanical defects in this "${group.label}" section, preserving ALL content:\n\n${content}`;
      const refined = await streamSectionContent(provider, {
        sessionId: `${sessionBase}-refine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        systemMessage: refineSystem,
        userMessage: refineUser,
        supportsCaching: false,
        temperature: 0.05,
        projectId,
      });
      const cleaned = cleanSectionMarkdown(refined.text);
      // Guard: ACCEPT only if the fixer preserved (essentially) all content.
      // A shorter result means it summarized/dropped detail — reject it and
      // keep the draft. Allow a tiny 5% slack for removed duplicate headings.
      if (cleaned.startsWith("#") && cleaned.length >= content.length * 0.95) {
        content = cleaned;
        truncation = mergeTruncation(truncation, refined.truncation);
        log.info("Section refine pass applied", {
          projectId,
          docType,
          group: group.id,
          draftLen: content.length,
        });
      } else {
        log.warn("Section refine output shorter than draft — keeping draft", {
          projectId,
          group: group.id,
          draftLen: content.length,
          refinedLen: cleaned.length,
        });
      }
    } catch (err) {
      log.warn("Section refine pass failed — keeping draft", {
        err: String(err),
        group: group.id,
      });
    }
  }

  return { markdown: content.trim(), truncation, maxTokens: draft.maxTokens };
}

/**
 * Outcome of one Phase-2 section call: the cleaned text plus whether the model
 * was CUT OFF by the output-token cap (#1226). Previously this returned a bare
 * string, so a truncated section was indistinguishable from a complete one and
 * was persisted with the document still marked `ready`.
 */
export interface SectionStreamResult {
  text: string;
  truncation: TruncationDetection;
  /** The OUTPUT cap that was in force, for the operator-facing warning. */
  maxTokens: number;
}

/**
 * Stream one Phase-2 LLM call and return the concatenated text plus a
 * truncation verdict. Streaming (not a single blocking call) keeps bytes
 * flowing so gateway/ALB idle timeouts and the provider's own stall watchdog
 * don't fire on long synthesis.
 */
async function streamSectionContent(
  provider: AIProvider,
  opts: {
    sessionId: string;
    systemMessage: string;
    userMessage: string;
    supportsCaching: boolean;
    temperature?: number;
    /** When provided, token usage is recorded to the project usage dashboard. */
    projectId?: string;
    /** #114 — counts chunks received, so a caller can tell a mid-stream drop. */
    progress?: { chunks: number };
  },
): Promise<SectionStreamResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemMessage },
    { role: "user", content: opts.userMessage },
  ];
  const chunks: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  // #1226 — the provider's stop signal, forwarded on the terminal `done` chunk.
  let finishReason: string | undefined;
  // #1226 — configurable OUTPUT cap (was hardcoded 8192), clamped to the
  // model's known ceiling.
  const maxTokens = resolveSectionMaxOutputTokens(provider.model);
  for await (const chunk of provider.stream(messages, {
    sessionId: opts.sessionId,
    disableTools: true,
    maxTokens,
    // #390 — tag prompt-cache hit-ratio telemetry by workload.
    callType: "synthesis",
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    // Cache ONLY the shared section-writer system prompt (reused across all ~6
    // sections). The large per-section facts/grounding blob in the user turn is
    // unique to THIS section group and not reused across calls, so a
    // message-level cache write would just burn the write premium with no later
    // read to amortise it (#389). #anthropic-prompt-caching.
    promptCaching: singleShotPromptCaching(opts.supportsCaching),
  })) {
    if (opts.progress) opts.progress.chunks += 1;
    if (chunk.type === "delta") {
      chunks.push(chunk.content);
    } else if (chunk.type === "usage") {
      promptTokens = chunk.usage.promptTokens;
      completionTokens = chunk.usage.completionTokens;
      cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
    } else if (chunk.type === "done") {
      finishReason = chunk.finishReason;
    }
  }
  // Record token usage for the project usage dashboard.
  if (opts.projectId && (promptTokens > 0 || completionTokens > 0)) {
    recordUsage({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      provider: provider.key,
      model: provider.model,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheReadTokens,
    });
  }
  // #1226 — strip the gateway's max-tokens placeholder BEFORE the text can
  // reach `generated_documents.content`, and report the verdict to the caller.
  const truncation = detectTruncation(chunks.join(""), finishReason);
  return { text: truncation.text.trim(), truncation, maxTokens };
}

/**
 * Normalise a generated section: strip preamble/H1, then repair code fences,
 * math blocks, and Mermaid labels so the markdown renders cleanly. Applied to
 * both the draft and (when enabled) the refined output.
 */
function cleanSectionMarkdown(raw: string): string {
  let content = raw.trim();
  // Strip any preamble before the first H2.
  if (!content.startsWith("##")) {
    const idx = content.indexOf("\n## ");
    if (idx > 0) content = content.slice(idx + 1);
  }
  // Strip any accidental H1 the model added.
  content = content.replace(/^# .+\n+/, "");
  // Repair malformed code fences — walk line-by-line, close any open
  // fence that looks broken (e.g. a markdown heading appearing inside
  // what should be a code block means the fence was never closed).
  content = repairCodeFences(content);
  // Repair broken LaTeX math blocks — ensure closing $$ is on its own
  // line and that unclosed display blocks don't swallow subsequent prose.
  content = repairMathBlocks(content);
  // Repair Mermaid diagrams — fix special characters in node labels that
  // cause nodes to render as empty boxes in the browser. Local models
  // (gemma4) don't reliably escape HTML-sensitive chars inside labels.
  content = repairMermaidBlocks(content);
  return content.trim();
}

/**
 * Repair Mermaid diagram blocks so node labels render correctly in the browser.
 *
 * Local models (gemma4:12b) frequently produce syntax that causes the Mermaid
 * renderer to render empty boxes or silently drop label text:
 *
 *   - Trailing `;` on the diagram type declaration (`graph TD;`) → full parse
 *     failure; Mermaid renders shapes without any labels for the whole block.
 *   - `<`, `>`, `&`, embedded `"` in node/edge labels → HTML breakage.
 *   - `:` (colon) in an unquoted `[label]` or `{label}` → Mermaid treats it as
 *     a class/link separator and silently drops the label text.
 *
 * All three are fixed by quoting the affected labels (Mermaid double-quote
 * syntax `A["label with : colon"]`) and stripping the type-line semicolon.
 * Already-quoted labels and already-clean labels are left untouched.
 */
export function repairMermaidBlocks(text: string): string {
  // A label needs quoting when it is NOT already fully quoted and contains
  // any character that Mermaid misparses in bare [label] context.
  const needsQuoting = (lbl: string): boolean => !lbl.startsWith('"') && /[<>&":]/.test(lbl);
  // Wrap a label: collapse inner double-quotes to single quotes, then quote.
  const quoteLabel = (lbl: string): string => `"${lbl.replace(/"/g, "'")}"`;

  return text.replace(/```mermaid([\s\S]*?)```/g, (_match, body: string) => {
    const repairedLines = body.split("\n").map((line, idx) => {
      // ── Strip trailing semicolon from the diagram-type declaration (first
      //    non-empty line). `graph TD;` is non-standard and causes the whole
      //    block to silently drop all node labels.
      if (
        idx === 0 ||
        (idx <= 2 && /^\s*(graph|flowchart|erDiagram|sequenceDiagram|classDiagram)\b/i.test(line))
      ) {
        line = line.replace(/;\s*$/, "");
      }
      // Also fix semicolons used as line terminators inside edge/node lines
      // (e.g. `A --> B;`). Mermaid flowcharts don't use statement terminators.
      if (/^\s*\w+\s*(-->|--\s|---\s|\|)/.test(line)) {
        line = line.replace(/;\s*$/, "");
      }

      // ── Edge labels: -->|label| or ---|label|
      line = line.replace(/(-{1,2}>?\s*)\|([^|]+)\|/g, (_m, arrow: string, lbl: string) => {
        if (needsQuoting(lbl)) {
          return `${arrow}|${quoteLabel(lbl)}|`;
        }
        return _m;
      });

      // ── Node shapes: A[label], A{label}, A(label), A([label]), A[[label]]
      // Only rewrite when the label needs quoting and isn't already quoted.
      line = line.replace(
        /(\w+)(\[{1,2}|\({1,2}|\{)([^}\]\n]+?)(\}{1,2}|\]{1,2}|\))/g,
        (_m, id: string, open: string, lbl: string, close: string) => {
          if (needsQuoting(lbl)) {
            return `${id}${open}${quoteLabel(lbl)}${close}`;
          }
          return _m;
        },
      );

      return line;
    });
    return "```mermaid" + repairedLines.join("\n") + "```";
  });
}

/**
 * Repair broken LaTeX display-math blocks ($$...$$).
 *
 * Two failure modes the LLM produces:
 * 1. Closing `$$` is immediately followed by prose on the same line:
 *    `\end{cases}$$ **Variables:**` → split to `\end{cases}\n$$\n\n**Variables:**`
 * 2. A display block is opened but never closed before a markdown heading
 *    or EOF — insert a closing `$$` before the heading / at EOF.
 */
function repairMathBlocks(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inMath = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Count $$ occurrences on this line (ignoring inline $ inside words).
    const ddMatches = line.match(/\$\$/g);
    const ddCount = ddMatches ? ddMatches.length : 0;

    if (!inMath) {
      if (ddCount % 2 === 1) {
        // Odd number of $$ → this line opens a display block.
        // Check if closing $$ is followed by non-whitespace prose on the
        // same line, e.g. `$$\end{cases}$$ **Variables:**`
        const trailingMatch = line.match(/\$\$(.+)$/);
        if (trailingMatch && trailingMatch[1].trim() !== "") {
          // The closing $$ has trailing prose — push up to (and including)
          // the closing $$, then the prose as a new line.
          const splitIdx = line.lastIndexOf("$$");
          result.push(line.slice(0, splitIdx + 2)); // up to closing $$
          result.push(""); // blank line after math block
          result.push(line.slice(splitIdx + 2).trim()); // trailing prose
        } else {
          // Normal opening $$ line — we're now inside a math block.
          inMath = true;
          result.push(line);
        }
      } else {
        // Even number of $$ — could be a complete inline `$$...$$` on one
        // line, or no math at all. Either way, not entering block mode.
        result.push(line);
      }
    } else {
      // Currently inside a display math block.
      if (ddCount % 2 === 1) {
        // Odd $$ → this line closes the math block.
        const trailingMatch = line.match(/\$\$(.+)$/);
        if (trailingMatch && trailingMatch[1].trim() !== "") {
          // Closing $$ has trailing prose on the same line — split it.
          const splitIdx = line.lastIndexOf("$$");
          result.push(line.slice(0, splitIdx + 2));
          result.push("");
          result.push(line.slice(splitIdx + 2).trim());
        } else {
          result.push(line);
        }
        inMath = false;
      } else if (/^#{1,4}\s/.test(line) || /^---$/.test(line)) {
        // A markdown heading or HR appeared inside an open math block —
        // the model forgot to close it. Insert a closing $$ first.
        result.push("$$");
        result.push("");
        inMath = false;
        result.push(line);
      } else {
        result.push(line);
      }
    }
  }

  // Unclosed math block at EOF.
  if (inMath) {
    result.push("$$");
  }

  return result.join("\n");
}

/**
 * Walk through markdown line-by-line and repair broken code fences.
 *
 * Detects two common LLM generation issues:
 * 1. A markdown heading (##) or horizontal rule (---) appearing inside an
 *    open code fence — inserts a closing fence before the heading.
 * 2. Incomplete trailing edges in mermaid blocks (e.g. `A -->` with no
 *    target) — removes the broken line.
 * 3. Unclosed fence at EOF — appends a closing fence.
 */
function repairCodeFences(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFence = false;
  let fenceLang = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,})([\w-]*)/);

    if (!inFence) {
      if (fenceMatch) {
        inFence = true;
        fenceLang = fenceMatch[2];
        result.push(line);
      } else {
        result.push(line);
      }
    } else {
      // Currently inside a code fence
      if (fenceMatch && !fenceMatch[2]) {
        // Closing fence found
        inFence = false;
        fenceLang = "";
        result.push(line);
      } else if (/^#{1,4}\s/.test(line)) {
        // A markdown heading appeared inside a code block — the LLM
        // forgot to close the previous fence. Close it now.
        result.push("```");
        inFence = false;
        fenceLang = "";
        result.push(line);
      } else if (fenceLang === "mermaid" && /^\s*\S+\s+--[->]+\s*$/.test(line)) {
        // Incomplete mermaid edge (no target) — skip this broken line
        continue;
      } else {
        result.push(line);
      }
    }
  }

  // If we ended still inside a fence, close it
  if (inFence) {
    result.push("```");
  }

  return result.join("\n");
}

// ============================================================================
// Doc-type-specific section groups
// ============================================================================

/**
 * Per-section topic keywords (#264). Used to widen a section's retrieval query
 * beyond its label so the RAG search surfaces sources relevant to the section's
 * subject matter. Keyed by section-group id; falls back to the label alone.
 */
const SECTION_TOPIC_KEYWORDS: Record<string, string[]> = {
  overview: ["business domain", "actors", "users", "purpose", "system overview"],
  capabilities: ["features", "capabilities", "functionality", "what the system does"],
  rules: ["business rules", "validation", "constraints", "policies", "eligibility", "thresholds"],
  workflows: ["workflow", "process", "steps", "lifecycle", "status transitions"],
  formulas: ["calculation", "formula", "pricing", "computation", "math"],
  "data-model": ["entities", "data model", "schema", "relationships", "fields"],
  "integrations-and-glossary": ["integrations", "external systems", "APIs", "glossary", "terms"],
  "overview-and-context": ["architecture overview", "context", "components", "system design"],
  "components-and-data": ["components", "modules", "data flow", "entities", "APIs"],
  "concerns-and-integrations": [
    "cross-cutting concerns",
    "integrations",
    "security",
    "observability",
  ],
  "ops-and-stack": ["operations", "deployment", "technology stack", "infrastructure"],
  intro: ["introduction", "getting started", "overview", "purpose"],
  tasks: ["tasks", "how to", "workflow", "user actions", "steps"],
  "rules-and-calcs": ["rules", "calculations", "formulas", "constraints"],
  "faq-and-glossary": ["FAQ", "glossary", "common questions", "terms", "definitions"],
};

/**
 * Build a section-topic retrieval query (#264): the section label, its topic
 * keywords, and the doc title combined into a single free-text query. This is
 * what makes per-section grounding land on section-relevant chunks instead of
 * the one doc-level title query that left broad sections ~96% ungrounded.
 */
export function buildSectionTopicQuery(
  group: { id: string; label: string },
  docTitle: string,
): string {
  const keywords = SECTION_TOPIC_KEYWORDS[group.id] ?? [];
  return [group.label, ...keywords, docTitle]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(" ");
}

/**
 * The ordered section groups for a document type, each carrying its
 * instructions and (where applicable) its per-section faithfulness gating
 * (`faithfulnessThreshold` + `narrative`/`reconstruction`). Exported so the
 * per-section gating wiring is unit-testable without a live synthesis run.
 */
export function sectionGroupsFor(docType: DocType): SectionGroup[] {
  switch (docType) {
    case "business-requirements":
      return [
        {
          id: "overview",
          factSlices: SECTION_FACT_SLICES["overview"],
          label: "Overview & Domain",
          // #283 — inherently abstractive: the prompt MANDATES business/domain
          // narrative absent from the code, so gate at the lower narrative bar
          // and frame the gap honestly rather than as "unreliable".
          faithfulnessThreshold: NARRATIVE_FAITHFULNESS_THRESHOLD,
          narrative: true,
          instructions: `Produce two sections:

## Executive Summary
3-5 sentences answering: What business problem does this system solve? Who uses it? What are the key business outcomes it delivers? Write for a non-technical executive audience.

## Business Domain Overview
Describe the business context. What industry/domain is this? Who are the main actors (roles, user types, external participants/entities)? What is the broader business process this system fits into?

After the prose, include a Mermaid \`graph LR\` diagram (max 10 nodes) showing the key actors and how they interact with the system. Example shape:

\`\`\`mermaid
graph LR
    A[Actor One] -->|action| S[The System]
    S -->|outputs to| B[Actor Two]
\`\`\``,
        },
        {
          id: "capabilities",
          factSlices: SECTION_FACT_SLICES["capabilities"],
          label: "Core Business Capabilities",
          // #283 — capabilities synthesis is abstractive over many modules and
          // carries domain framing; gate at the narrative bar with honest copy.
          faithfulnessThreshold: NARRATIVE_FAITHFULNESS_THRESHOLD,
          narrative: true,
          instructions: `Produce ONE section:

## Core Business Capabilities
The major business capabilities the system provides, grouped logically (NOT one entry per code module — synthesize). Use H3 per capability. For each capability give 2-3 sentences on what it does, plus a bullet list of the specific features within that capability. Cover ALL major functional areas visible in the source facts.`,
        },
        {
          id: "rules",
          factSlices: SECTION_FACT_SLICES["rules"],
          minedRules: true,
          label: "Business Rules & Policies",
          instructions: `Produce ONE section:

## Business Rules & Policies
THIS IS THE MOST CRITICAL SECTION OF THE ENTIRE DOCUMENT. A COMPLETE, EXHAUSTIVE, DEDUPLICATED catalog of ALL business rules, validations, eligibility checks, thresholds, constraints, policies, status transitions, and invariants enforced anywhere in the system.

STRUCTURE: Group related rules under H3 sub-sections. Example groupings (adapt to the domain):
- "Eligibility & Qualification Rules"
- "Validation Rules" (further split by entity if many)
- "Pricing, Cost & Financial Rules"
- "Invoicing & Billing Rules"
- "Timing, Deadlines & Scheduling Rules"
- "Status Transitions & Lifecycle Rules"
- "Inventory & Resource Rules"
- "Security & Access Control Rules"

FOR EACH RULE: Write a numbered bullet with:
1. **Rule name/ID** (bold) — a short descriptive name
2. **Condition**: The exact condition that triggers the rule (quote field names, constants, thresholds)
3. **Action/Consequence**: What happens when the condition is met or violated
4. **Exceptions/Edge Cases**: Any special cases or overrides

Use TABLES where a set of related rules share the same structure (e.g., a table of validation rules with columns: Field | Condition | Error | Severity).

DEPTH REQUIREMENT: If the source facts mention 50 rules, ALL 50 must appear here — not summarized as "various validations exist". Every threshold, every boundary check, every conditional branch is a separate documented rule.`,
        },
        {
          id: "workflows",
          factSlices: SECTION_FACT_SLICES["workflows"],
          label: "Key Workflows",
          // The prompt below MANDATES reconstruction (explicit Trigger /
          // Preconditions / Postconditions / Error Paths per workflow) that the
          // source rarely states verbatim, so the strict 0.80 bar was
          // unreachable even for accurate sections (the SAS `risk` 0/7 case). Gate
          // at the moderate reconstruction bar with honest "inferred — verify"
          // copy. NOT marked `narrative`: for code-rich languages this content
          // should still be strongly grounded, so 0.60 (not the 0.40 narrative
          // floor) keeps genuinely-bad sections flagged.
          faithfulnessThreshold: RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
          reconstruction: true,
          instructions: `Produce ONE section:

## Key Workflows
ALL significant business processes the system supports — not just the top 4-6, but every distinct workflow visible in the facts. Focus on BUSINESS workflows (order fulfilment, onboarding, invoicing, reconciliation, ETL/data pipelines), not trivial utility operations (auth header parsing, date conversions).

RECONSTRUCTION REQUIREMENT: every workflow MUST be stated as an explicit **Inputs → Steps/Decisions → Outputs** pipeline so a developer could rebuild it. For EACH workflow:
- H3 with the workflow name
- **Trigger**: What initiates this workflow (user action, schedule, external event)
- **Inputs**: The concrete data consumed — name the source entities/datasets (use the DATASET LINEAGE / DATA_LINEAGE facts: which datasets are READ) and any parameters. When the facts include cross-module flow, name the upstream module that produced each input.
- **Preconditions**: What must be true before it can start
- **Steps & Decisions**: A COMPLETE numbered list of every step IN ORDER, including each decision point (state the condition and both branches), every validation performed, and what happens on failure. Reference the specific transformations/rules applied.
- **Outputs**: The concrete data produced — name the result entities/datasets (use DATA_LINEAGE: which datasets are WRITTEN) and where they flow next (the downstream module/consumer, when known from the cross-module flow).
- **Postconditions**: What state the system is in after successful completion
- **Error/Exception Paths**: What happens when things go wrong at each step
- A Mermaid \`sequenceDiagram\` OR \`flowchart TD\` showing the steps (max 12 nodes)

DEPTH REQUIREMENT: Each workflow must document EVERY validation check AND every dataset/entity it reads or writes. Where the END-TO-END FLOW facts show one module's output feeding another's input, chain them into a single cross-module workflow rather than two isolated ones.`,
        },
        {
          id: "formulas",
          factSlices: SECTION_FACT_SLICES["formulas"],
          label: "Calculations & Formulas",
          instructions: `Produce ONE section:

## Calculations & Formulas
EVERY calculation/formula the system performs — this must be a COMPLETE reference. Group by domain area under H3 sub-sections (e.g., "Inventory Calculations", "Pricing Calculations", "Invoice Calculations", "Pro-rata Allocation"). For each formula:
- **Name** (bold)
- Plain-English description of what it computes and when it's used
- LaTeX notation: $$formula$$
- **Variables**: define every variable/term
- **Edge cases**: What happens with zero/null/boundary values
- **Related rules**: Which business rules constrain the inputs/outputs

Use a summary table at the end of each sub-section: | Formula | Purpose | Key Variables |`,
        },
        {
          id: "data-model",
          factSlices: SECTION_FACT_SLICES["data-model"],
          label: "Data & Domain Model",
          // The prompt below MANDATES a reconstruction-grade per-field data
          // dictionary (Type / Constraint / Default / Range) that the code rarely
          // spells out fully, so much of it is legitimately inferred and the
          // strict 0.80 bar false-flagged accurate sections (the SAS `risk` 26%
          // case). Gate at the moderate reconstruction bar with honest "inferred
          // — verify" copy; NOT `narrative`, so well-sourced languages stay
          // policed at 0.60 rather than the 0.40 narrative floor.
          faithfulnessThreshold: RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
          reconstruction: true,
          instructions: `Produce ONE section:

## Data & Domain Model
The core business entities and their relationships, documented as a RECONSTRUCTION-GRADE DATA DICTIONARY — detailed enough to recreate the schema. Include a Mermaid \`erDiagram\` showing 8-15 of the most important entities and their relationships. Below the diagram, define EACH entity with:
- H4 with entity name
- 2-3 sentences on its purpose and business meaning
- **A per-field data dictionary TABLE** with one row per field and these columns:
  | Field | Type | Constraint | Default | Range/Allowed values | Description |
  Fill EVERY column you can derive from the facts (types, NOT NULL / required, unique/PK/FK, defaults, numeric ranges, enum/allowed values, regex/length limits). If a value is genuinely unknown from the facts, write \`—\` (do NOT invent values).
- **Relationships**: foreign keys / references to other entities (cardinality where known)
- **Lifecycle notes**: how the entity is created, modified, archived (tie to the workflows/lineage where the facts show which workflow writes it)

For SAS / dataset-centric projects, treat each DATASET as an entity and use the DATA_LINEAGE / DATASET LINEAGE facts to record which workflow produces it and which consume it.

Example shape:
\`\`\`mermaid
erDiagram
    ENTITY_ONE ||--o{ ENTITY_TWO : "has many"
    ENTITY_ONE {
        string identifier
        string name
    }
\`\`\``,
        },
        {
          id: "integrations-and-glossary",
          factSlices: SECTION_FACT_SLICES["integrations-and-glossary"],
          label: "Integrations & Glossary",
          instructions: `Produce two sections:

## Integrations & External Systems
What external systems, databases, message queues, or services this system depends on or feeds. Brief description of each integration's purpose and data exchanged. Use a table: | System | Direction | Data | Purpose |

## Glossary
Alphabetical list of domain terms, abbreviations, and acronyms with concise definitions. Aim for 15-30 entries. Use a two-column table: | Term | Definition |`,
        },
      ];

    case "architecture":
      return [
        {
          id: "overview-and-context",
          factSlices: SECTION_FACT_SLICES["overview-and-context"],
          label: "Overview, Context & Layers",
          instructions: `Produce three sections.

## Overview
2-3 paragraphs: What does the system do? What is its primary architectural style (layered monolith, event-driven, microservices, hexagonal, etc.)? What are the key technology choices visible in the source facts?

## System Context
A C4-style system context diagram showing the system as a black box with its external actors and dependencies. Use Mermaid \`graph TB\` (max 12 nodes). Below the diagram, briefly describe each external dependency in 1 sentence each.

\`\`\`mermaid
graph TB
    User([End User])
    System[The System]
    DB[(Database)]
    Ext[External API]
    User --> System
    System --> DB
    System --> Ext
\`\`\`

## Logical Architecture
The major logical layers/tiers (e.g., presentation, application, domain, persistence). Include a Mermaid \`graph TB\` showing layers with dependency direction. Describe each layer's responsibility in 1-2 sentences.`,
        },
        {
          id: "components-and-data",
          factSlices: SECTION_FACT_SLICES["components-and-data"],
          label: "Components & Data Architecture",
          instructions: `Produce two sections.

## Component Breakdown
Group the source modules into 4-8 logical components (NOT one entry per module — SYNTHESIZE related modules into cohesive components). Include a Mermaid \`graph LR\` component diagram (max 12 nodes) showing the components and their interactions.

For each component:
- H3 with the component name
- **Purpose**: 2-3 sentences explaining what business/technical problem it solves
- **Responsibilities**: bullet list (5-10 items) — be specific about what this component DOES
- **Key classes/interfaces**: bullet list (top 5-8) with 1-sentence description of each
- **Key algorithms/logic**: Any notable processing, transformation, or decision logic within this component
- **Depends on**: which other components it uses and WHY
- **API surface**: The main methods/endpoints other components call on this one

## Data Architecture
The persistence model, documented as a RECONSTRUCTION-GRADE DATA DICTIONARY. Include a Mermaid \`erDiagram\` for the main 8-15 entities and relationships. Below the diagram:
- For each entity, give a per-field table with columns: | Field | Type | Constraint | Default | Range/Allowed values | Description |. Fill every column derivable from the facts; use \`—\` when genuinely unknown (do NOT invent). Note PK/FK/unique constraints.
- Describe data stores (databases, caches, message queues) and why each was chosen
- For SAS / dataset-centric systems, treat each DATASET as an entity and use the DATA_LINEAGE / DATASET LINEAGE facts to record its producing and consuming steps.
- Document data lifecycle: creation triggers, mutation events, archival/deletion rules
- Note any persistence patterns: event sourcing, CQRS, soft deletes, audit trails, versioning
- Document indexes, constraints, and data integrity rules visible in the facts`,
        },
        {
          id: "concerns-and-integrations",
          factSlices: SECTION_FACT_SLICES["concerns-and-integrations"],
          label: "Cross-Cutting Concerns & Integrations",
          instructions: `Produce two sections.

## Cross-Cutting Concerns
How the system handles: security/authentication/authorization, logging, error handling, caching, scheduling/jobs, transactions, configuration, metrics/observability, validation. Use H3 per concern. Quote actual mechanisms found in the source facts; do NOT make up libraries that aren't mentioned.

## Integration Points
External APIs, message buses, downstream/upstream systems this codebase talks to. Use a bullet list with brief purpose for each. Then include ONE Mermaid \`sequenceDiagram\` for the most critical integration flow (max 8 participants):

\`\`\`mermaid
sequenceDiagram
    participant A
    participant B
    A->>B: request
    B-->>A: response
\`\`\``,
        },
        {
          id: "ops-and-stack",
          factSlices: SECTION_FACT_SLICES["ops-and-stack"],
          label: "Algorithms, Operations & Stack",
          instructions: `Produce three sections.

## Key Algorithms & Calculations
Notable algorithms and formulas implemented in the codebase, with LaTeX where applicable. Brief plain-English description first, then formula. Group by domain.

## Operational Considerations
What's visible about deployment topology (containers, env vars, configs), runtime characteristics (long-running jobs, scheduled tasks, batch processing), scaling concerns, and operational gotchas. Be specific to what the source facts reveal.

## Technology Stack
Languages, frameworks, libraries, build tools, infrastructure that are visible from the source code analysis. Use a categorised bullet list (Languages, Frameworks, Persistence, Infrastructure, etc.). Do NOT speculate about technologies that aren't supported by the facts.`,
        },
      ];

    case "user-guide":
      return [
        {
          id: "intro",
          factSlices: SECTION_FACT_SLICES["intro"],
          label: "Introduction & Getting Started",
          instructions: `Produce three sections.

## Introduction
2-3 paragraphs: What is this system? Who is it for? What can users accomplish with it? Plain language, no jargon.

## Key Concepts
The 6-10 core domain concepts users need to understand BEFORE they start. Each concept gets a H3 heading and 1-2 sentences in plain language. After the concept definitions, include a Mermaid \`graph LR\` diagram (max 10 nodes) showing how the main concepts relate to each other.

## Getting Started
A high-level walkthrough of what a brand-new user does first. Use a numbered list (5-8 steps). Then include a Mermaid \`flowchart TD\` showing the onboarding flow:

\`\`\`mermaid
flowchart TD
    A[Step 1] --> B[Step 2]
    B --> C{Decision?}
    C -->|Yes| D[Result]
    C -->|No| E[Alternative]
\`\`\``,
        },
        {
          id: "tasks",
          factSlices: SECTION_FACT_SLICES["tasks"],
          label: "Common Tasks",
          instructions: `Produce ONE section: ## Common Tasks

The 6-10 most important tasks users perform with the system, organized by USER GOAL (not by code module). Pick the most valuable tasks based on the workflows in the facts. For EACH task:

- H3 with a goal-oriented task name (e.g., "Submit a Shipment Quote", not "Use QuoteService")
- **Goal**: 1 sentence on what the user wants to accomplish
- **Steps**: numbered procedure (3-8 steps)
- **Result**: what the user will see when done
- **Tips/Notes**: a blockquote callout (\`> **Tip:**\` or \`> **Note:**\` or \`> **Warning:**\`) with caveats, prerequisites, or gotchas

For 1-2 of the most complex tasks, include a small Mermaid \`flowchart TD\` showing the decision points.`,
        },
        {
          id: "rules-and-calcs",
          factSlices: SECTION_FACT_SLICES["rules-and-calcs"],
          minedRules: true,
          label: "Rules, Calculations & Outputs",
          instructions: `Produce three sections.

## Business Rules to Know
ALL rules and constraints users must work within — this is the user-facing translation of every business rule that affects their experience. Organize under H3 sub-sections by user concern (e.g., "Submission Deadlines", "Eligibility Requirements", "What Gets Rejected", "Limits & Quotas").

For each rule:
- State the rule in plain user-facing language
- Give the specific threshold/value/deadline
- Explain what happens if violated (error message, rejection, penalty)

Use a TABLE for dense sets of related rules (e.g., validation rules table with columns: What | Requirement | If Violated).

DEPTH REQUIREMENT: Every rule from the facts that a user could encounter must appear here. If there are 30 validation rules, all 30 must be documented in user-friendly language.

## Calculations Reference
For users who need to understand how the system computes the values they see (charges, invoices, allocations, prices, quantities). For EACH calculation:
- **What it computes** (bold) — user-friendly name
- Plain English explanation of what it means to the user
- LaTeX formula: $$formula$$
- **Where you'll see it**: Which screen/report shows this value
- **Example**: A concrete worked example with sample numbers

Group by what the user is looking at (e.g., "Your Bill", "Stock Levels", "Invoice Charges").

## Reports & Outputs
What information the system produces for users — reports, exports, notifications, dashboards, statements. For EACH output:
- **Name** and where to find it
- What data it contains (list the key fields/columns)
- When it's generated (schedule, on-demand, triggered by event)
- Who can access it (roles/permissions if visible)`,
        },
        {
          id: "faq-and-glossary",
          factSlices: SECTION_FACT_SLICES["faq-and-glossary"],
          label: "FAQ & Glossary",
          instructions: `Produce two sections.

## Frequently Asked Questions
8-12 anticipated questions a user would realistically ask. Use H3 for each question phrased as a real user would ask it (e.g., "Why was my submission rejected?"). Answer in 1-3 sentences grounded in the actual system behavior from the facts. Do NOT invent answers.

## Glossary
Alphabetical list of all domain terms, abbreviations, and acronyms users will encounter. 15-30 entries. Use a definition list format or a two-column table.`,
        },
      ];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function docTypeLabel(docType: DocType): string {
  switch (docType) {
    case "business-requirements":
      return "Business Requirements";
    case "architecture":
      return "Architecture";
    case "user-guide":
      return "User Guide";
  }
}

function renderEmptyDocument(title: string, docType: DocType, meta: ProjectMeta): string {
  return `# ${title}\n\n*No documentable modules were found in **${meta.name}**.*\n\nThis ${docTypeLabel(docType)} document could not be generated because the project's code graph contains no business-logic modules large enough to summarize. Try ingesting more source code, or verify that test/generated/build directories are not the only content.\n`;
}

function renderOfflineDocument(
  title: string,
  docType: DocType,
  meta: ProjectMeta,
  facts: ModuleFacts[],
): string {
  return `# ${title}\n\n> **Offline mode** — LLM synthesis was skipped. The following is a raw catalog of facts extracted from each module.\n\nProject: **${meta.name}** (${meta.language}) — ${meta.totalFiles} files, ${meta.totalSymbols} symbols.\nDocument type: ${docTypeLabel(docType)}\n\n${facts.map((f) => `## ${f.moduleName}\n\n*${f.classCount} classes / ${f.methodCount} methods*\n\n${f.facts}\n`).join("\n")}`;
}
