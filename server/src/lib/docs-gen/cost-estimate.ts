/**
 * #2189 — what a business-requirements document is estimated to cost, before
 * it is generated.
 *
 * A full-project BRD of three tiny fixture repositories cost $2.26 on Claude
 * Sonnet 5.5 (#1749), and the Generate dialog said nothing until the run had
 * finished. This module answers, before the run, with a RANGE.
 *
 * WHAT THE ESTIMATE IS BUILT FROM. The plan the generator would run, as far as
 * it is known without a model call:
 *
 *   - the documentable modules, grouped from the scope's indexed symbols by the
 *     generator's own rules (`groupSymbolsIntoModules`, the Phase-1 test-file
 *     policy and the path scope), each with its source lines;
 *   - which of them already have Phase-1 facts in the fact cache for the
 *     configured Phase-1 model and prompt version — those are not extracted
 *     again, so a re-run costs less than a first run;
 *   - the document's sections (`sectionGroupsFor`) and its length cap
 *     (`DOCS_GEN_DOCUMENT_MAX_CHARS`);
 *   - the configured Phase-1, Phase-2, claim-extraction and judge models.
 *
 * From those it lays out the run's model calls — one per Phase-1 chunk, a
 * write and a judge call per section, the extra batch calls a catalogue section
 * needs once the facts outgrow one call, a claim-extraction call per write —
 * each with an estimated prompt and reply length, and prices them through the
 * SAME path as the after-run tally (`RunUsage` → `estimateRunCost` in
 * `run-cost.ts`, which reads `lib/finops/provider-rates.ts`). A model with a
 * prompt-length price tier (Claude Haiku 5.5) is priced per call, so a run whose
 * wide section calls cross the threshold is priced in the long tier.
 *
 * Nothing is invented: a model METIS has no price for makes the estimate
 * `unpriced` (it names the model) instead of a total that silently leaves it
 * out, and a run on self-hosted or zero-priced models is `free`, never "$0".
 *
 * HOW FAR IT MAY BE OFF. The constants below are fitted to 16 measured runs, and
 * `cost-estimate.calibration.test.ts` re-checks the estimate against every one
 * of them: the #1749 fixture BRD on Sonnet 5.5, a first-run Miniflux BRD on
 * Haiku 5.5, and seven first-run and seven re-run Miniflux BRDs on DeepSeek
 * Flash. The point estimate came within -12% to +30% of what each cost (the
 * test pins each run's error). Those errors are in-sample, so the range shown
 * is wider: the point estimate × {@link RANGE_LOW_FACTOR} to ×
 * {@link RANGE_HIGH_FACTOR}, which holds an actual cost from 33% below the
 * point estimate to 43% above it — narrow enough to tell a $0.40 run from a
 * $2 one. Only two codebases and three model families were measured; a model
 * with very different verbosity (one that reasons at length) can land outside.
 *
 * WHAT IT DOES NOT COUNT. Directories holding only `.sql` files, which the
 * generator finds on disk at run time; web-research grounding; a Phase-1
 * cache entry whose source has since changed (it is counted as cached), and a
 * module of several chunks with only some of them cached (counted as cached:
 * a cache row names its module's directory, not its chunk or repository). A
 * directory two of the project's repositories share is never counted cached,
 * since its row may be the other repository's; a row left by a repository the
 * project no longer has can still mark a directory cached; hybrid
 * per-section routing (`DOCS_GEN_HYBRID_ROUTING`), which is priced as if every
 * section ran on the primary Phase-2 model; and prompt-cache discounts, so a
 * provider that caches prompts lands toward the low end.
 *
 * #2189 also asked whether a small project should get a shorter default
 * document. It does not, and the measurement says why: the #1749 BRD was
 * 111,550 characters against a 250,000-character document cap, so the cap never
 * bound it — its length came from each of its seven sections being written at
 * full depth from very few facts. A lower default cap would not have shortened
 * it; the lever is the per-section budget, which is a model-quality change to
 * measure on its own, not a default to lower blind. The estimate now shows the
 * analyst the cost before the run, which was the harm.
 */
import { isJunkSourcePath } from "@metis/shared";
import { prisma } from "../prisma.js";
import { RunUsage, estimateRunCost, type RunUsageEvent } from "./run-cost.js";
import { excludeTestFiles, groupSymbolsIntoModules } from "./module-grouping.js";
import { PathScopeEmptyError, restrictToPathScope } from "./path-scope.js";
import {
  phase1ChunkLimits,
  resolvePhase1ChunkInputTokens,
  resolvePhase1IncludeTests,
} from "./phase1-chunking.js";
import { resolveDocumentMaxChars } from "./section-size.js";

// ---------------------------------------------------------------------------
// The call model. Lengths are in CHARACTERS, so one set of constants serves
// every model; each model's tokenizer is applied when a call is priced
// ({@link charsPerToken}). Each constant names the measurement it came from.
// ---------------------------------------------------------------------------

/**
 * Phase-1 prompt characters per indexed source line. Miniflux (82,415 lines
 * over 102 modules) took 2.17M characters of Phase-1 prompt on DeepSeek Flash
 * and 2.37M on Haiku 5.5 / Sonnet 5.5, less the per-chunk overhead below.
 */
export const PHASE1_PROMPT_CHARS_PER_LINE = 22;
/** Phase-1 prompt characters every chunk carries (instructions, inventories). */
export const PHASE1_PROMPT_CHARS_PER_CHUNK = 4_000;
/** Phase-1 reply (facts) characters per source line: Miniflux wrote 1.2M–1.6M. */
export const PHASE1_REPLY_CHARS_PER_LINE = 15;
/** Phase-1 reply characters every chunk writes: #1749 wrote ~33k over 10 chunks. */
export const PHASE1_REPLY_CHARS_PER_CHUNK = 3_000;

/** Fixed prompt characters of every section write and judge call. */
export const SECTION_PROMPT_CHARS = 12_000;
/**
 * The share of the facts a section call reads, up to {@link SECTION_FACTS_CAP_FACTOR}
 * times the provider's facts cap. #1749's section calls averaged ~31k
 * characters of prompt from ~33k of facts; Miniflux's widest averaged ~250k
 * (109k Haiku 5.5 tokens, 68k DeepSeek tokens) against a 150k facts cap.
 */
export const SECTION_FACTS_SHARE = 0.6;
export const SECTION_FACTS_CAP_FACTOR = 1.6;
/**
 * Prompt characters of the extra batch calls per character of facts beyond one
 * facts cap: the catalogue sections and their judge read the rest in batches.
 * Fitted to Miniflux's ~6.7M characters of Phase-2 prompt.
 */
export const BATCH_PROMPT_CHARS_PER_FACT_CHAR = 2;
/** Prompt characters one extra batch call reads. */
export const BATCH_CALL_PROMPT_CHARS = 40_000;

/** A section's length before facts: #1749's seven sections wrote 111,550 characters. */
export const SECTION_BASE_CHARS = 14_000;
/** Document characters per character of facts, until the document cap binds. */
export const DOCUMENT_CHARS_PER_FACT_CHAR = 1;
/**
 * Characters written in Phase 2 per character of the finished document: the
 * drafts the caps cut, the judge's verdicts, any reasoning the model bills as
 * output. #1749: ~2.4 (Sonnet 5.5); Miniflux: 2.8–4.9 (DeepSeek), 4.1 (Haiku 5.5).
 */
export const PHASE2_REPLY_CHARS_PER_DOCUMENT_CHAR = 3.2;

/** Claim-extraction calls per section write call (#1749: 10 for 7 sections). */
export const CLAIM_CALLS_PER_WRITE = 1.4;
/** One claim-extraction call's prompt and reply (#1749: ~4.5k / ~2.1k Haiku 4.5 tokens). */
export const CLAIM_PROMPT_CHARS = 16_000;
export const CLAIM_REPLY_CHARS = 7_000;

/** The range shown: the point estimate times these. See the module header. */
export const RANGE_LOW_FACTOR = 0.7;
export const RANGE_HIGH_FACTOR = 1.5;

/**
 * Characters per token. Claude 5-generation models tokenize the same Miniflux
 * Phase-1 prompts into 1.58× the tokens DeepSeek Flash does (871k vs 550k);
 * 3.5 is the generator's own figure for everything else
 * (`PHASE1_INPUT_CHARS_PER_TOKEN`).
 */
export function charsPerToken(model: string): number {
  return /claude-(?:haiku|sonnet|opus|fable)-5(?:\b|-)/.test(model) ? 2.2 : 3.5;
}

// ---------------------------------------------------------------------------
// Pure part
// ---------------------------------------------------------------------------

/** One documentable module of the plan. */
export interface CostPlanModule {
  /** Indexed source lines (each file's last symbol line, summed). */
  lines: number;
  /** Its Phase-1 facts are in the fact cache, so it is not extracted again. */
  cached: boolean;
}

/** What the generator would run, as far as it is known before a model call. */
export interface CostPlan {
  modules: readonly CostPlanModule[];
  /** Sections of the document type. */
  sections: number;
  /** `DOCS_GEN_DOCUMENT_MAX_CHARS`. */
  documentMaxChars: number;
  /** The Phase-2 provider's facts cap, in characters. */
  factsCharCap: number;
  /** One Phase-1 chunk's source budget, in characters. */
  phase1ChunkInputChars: number;
}

/** A provider + model, as usage is recorded under it. */
export interface CostModel {
  provider: string;
  model: string;
}

/** The models a run would call. */
export interface CostModels {
  phase1: CostModel;
  phase2: CostModel;
  claim: CostModel;
  judge: CostModel;
}

/** The plan's size, as the dialog states it. */
export interface CostPlanSummary {
  modules: number;
  /** Modules whose facts are not cached, so Phase 1 extracts them. */
  modulesToExtract: number;
  sourceLines: number;
  sections: number;
  modelCalls: number;
  estimatedDocumentChars: number;
}

/**
 * The estimate. `priced`: a range in USD. `unpriced`: some model the run would
 * call has no price, named in `unpricedModels`. `free`: every model is
 * self-hosted or priced at zero. `no-code`: the scope has no documentable code,
 * so the run would not produce a document.
 */
export interface GenerationCostEstimate {
  status: "priced" | "unpriced" | "free" | "no-code";
  lowUsd: number | null;
  highUsd: number | null;
  /** `provider/model` of each model the run would call. */
  models: string[];
  unpricedModels: string[];
  /** Models with no per-token price (self-hosted, or priced at zero). */
  freeModels: string[];
  plan: CostPlanSummary;
}

const label = (m: CostModel): string => `${m.provider}/${m.model}`;

/** `count` calls of one model, each with the given prompt and reply characters. */
function calls(
  out: RunUsageEvent[],
  model: CostModel,
  count: number,
  promptChars: number,
  replyChars: number,
): void {
  const cpt = charsPerToken(model.model);
  const inputTokens = Math.ceil(promptChars / cpt);
  const outputTokens = Math.ceil(replyChars / cpt);
  for (let i = 0; i < count; i++) {
    out.push({ provider: model.provider, model: model.model, inputTokens, outputTokens });
  }
}

/**
 * The run's model calls, as usage events with estimated token counts, and the
 * document length they are planned against.
 */
export function planModelCalls(
  plan: CostPlan,
  models: CostModels,
): { events: RunUsageEvent[]; documentChars: number } {
  const events: RunUsageEvent[] = [];
  const chunkChars = Math.max(1, plan.phase1ChunkInputChars);
  let facts = 0;
  for (const m of plan.modules) {
    const lines = Math.max(0, m.lines);
    const chunks = Math.max(1, Math.ceil((lines * PHASE1_PROMPT_CHARS_PER_LINE) / chunkChars));
    const reply = chunks * PHASE1_REPLY_CHARS_PER_CHUNK + lines * PHASE1_REPLY_CHARS_PER_LINE;
    facts += reply;
    if (m.cached) continue;
    const prompt = chunks * PHASE1_PROMPT_CHARS_PER_CHUNK + lines * PHASE1_PROMPT_CHARS_PER_LINE;
    calls(events, models.phase1, chunks, prompt / chunks, reply / chunks);
  }

  const sections = Math.max(0, plan.sections);
  const documentChars = Math.min(
    plan.documentMaxChars,
    sections * SECTION_BASE_CHARS + facts * DOCUMENT_CHARS_PER_FACT_CHAR,
  );
  const sectionPrompt =
    SECTION_PROMPT_CHARS +
    Math.min(facts * SECTION_FACTS_SHARE, plan.factsCharCap * SECTION_FACTS_CAP_FACTOR);
  const batchPromptChars =
    BATCH_PROMPT_CHARS_PER_FACT_CHAR * Math.max(0, facts - Math.min(facts, plan.factsCharCap));
  // Batch calls come in pairs: a write and its judge.
  const batchPairs = Math.ceil(batchPromptChars / BATCH_CALL_PROMPT_CHARS / 2);
  const writes = sections + batchPairs;
  const phase2Calls = 2 * writes;
  const replyPerCall =
    phase2Calls > 0 ? (documentChars * PHASE2_REPLY_CHARS_PER_DOCUMENT_CHAR) / phase2Calls : 0;
  calls(events, models.phase2, sections, sectionPrompt, replyPerCall);
  calls(events, models.judge, sections, sectionPrompt, replyPerCall);
  calls(events, models.phase2, batchPairs, BATCH_CALL_PROMPT_CHARS, replyPerCall);
  calls(events, models.judge, batchPairs, BATCH_CALL_PROMPT_CHARS, replyPerCall);
  calls(
    events,
    models.claim,
    Math.ceil(writes * CLAIM_CALLS_PER_WRITE),
    CLAIM_PROMPT_CHARS,
    CLAIM_REPLY_CHARS,
  );
  return { events, documentChars };
}

const floorCents = (usd: number): number => Math.floor(usd * 100) / 100;
const ceilCents = (usd: number): number => Math.ceil(usd * 100) / 100;

/** Price a plan. Pure apart from the configured prices `resolveRate` reads. */
export function estimateFromPlan(plan: CostPlan, models: CostModels): GenerationCostEstimate {
  const { events, documentChars } = planModelCalls(plan, models);
  const usage = new RunUsage();
  for (const e of events) usage.add(e);
  const priced = estimateRunCost(usage);
  const used = [...new Set(events.map((e) => `${e.provider}/${e.model}`))];
  const lineLabels = (pricing: string): string[] => [
    ...new Set(priced.lines.filter((l) => l.pricing === pricing).map(label)),
  ];
  const unpricedModels = lineLabels("unpriced");
  const freeModels = [...lineLabels("self-hosted"), ...lineLabels("zero-priced")];
  const summary: CostPlanSummary = {
    modules: plan.modules.length,
    modulesToExtract: plan.modules.filter((m) => !m.cached).length,
    sourceLines: plan.modules.reduce((n, m) => n + Math.max(0, m.lines), 0),
    sections: plan.sections,
    modelCalls: events.length,
    estimatedDocumentChars: Math.round(documentChars),
  };
  const base = { models: used, unpricedModels, freeModels, plan: summary };
  if (unpricedModels.length > 0) {
    return { status: "unpriced", lowUsd: null, highUsd: null, ...base };
  }
  if (priced.estimatedCostUsd === null) {
    return { status: "free", lowUsd: null, highUsd: null, ...base };
  }
  const point = priced.estimatedCostUsd;
  return {
    status: "priced",
    lowUsd: floorCents(point * RANGE_LOW_FACTOR),
    highUsd: ceilCents(point * RANGE_HIGH_FACTOR),
    ...base,
  };
}

/** The point estimate in USD (`null` unless every model is priced), for calibration. */
export function pointEstimateUsd(plan: CostPlan, models: CostModels): number | null {
  const usage = new RunUsage();
  for (const e of planModelCalls(plan, models).events) usage.add(e);
  const priced = estimateRunCost(usage);
  return priced.lines.some((l) => l.pricing === "unpriced") ? null : priced.estimatedCostUsd;
}

// ---------------------------------------------------------------------------
// The plan, read from the project
// ---------------------------------------------------------------------------

/** Each module's source lines: every file's last symbol line, summed. */
export function moduleSourceLines(
  syms: ReadonlyArray<{ filePath: string; endLine: number }>,
): number {
  const lastLine = new Map<string, number>();
  for (const s of syms) {
    lastLine.set(s.filePath, Math.max(lastLine.get(s.filePath) ?? 0, s.endLine));
  }
  let lines = 0;
  for (const n of lastLine.values()) lines += Math.max(0, n);
  return lines;
}

/** The symbol columns the grouping and the line count read; the rest of the row is not loaded. */
type CostPlanSymbol = {
  id: string;
  qualifiedName: string;
  kind: string;
  language: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  codeGraphId: string;
};

/** A module of the project's plan, before the request's repository and path scope. */
type PlannedModule = { dir: string; codeGraphId: string; syms: CostPlanSymbol[] };

/** The project's modules, grouped once per project, test policy and index. */
interface ProjectPlan {
  modules: PlannedModule[];
  /**
   * Module directories more than one repository of the project has. A fact
   * cache row names its module's directory but not its repository, so a row
   * for one of these may be another repository's: never counted as cached.
   */
  sharedDirs: ReadonlySet<string>;
}

/**
 * How long a project's grouped plan is reused. The form asks for an estimate
 * on open, on a repository change and on every debounced path edit; the
 * symbols behind it change only when the project is re-indexed, which also
 * changes the key. The fact cache is still read on every estimate: a run
 * fills it.
 */
export const COST_PLAN_TTL_MS = 60_000;
const COST_PLAN_CACHE_MAX = 32;
const projectPlans = new Map<string, { at: number; plan: Promise<ProjectPlan> }>();

/** Forget every cached plan (tests). */
export function clearCostPlanCache(): void {
  projectPlans.clear();
}

async function readProjectPlan(projectId: string, includeTests: boolean): Promise<ProjectPlan> {
  const rows = await prisma.codeSymbol.findMany({
    where: { projectId },
    select: { kind: true, language: true, filePath: true, endLine: true, codeGraphId: true },
  });
  const symbols: CostPlanSymbol[] = [];
  for (const r of rows) {
    if (isJunkSourcePath(r.filePath)) continue;
    // The grouping's other columns are not read by its rules (module-grouping.ts).
    symbols.push({ ...r, id: "", qualifiedName: "", startLine: 0 });
  }
  const grouped = groupSymbolsIntoModules(
    symbols,
    (s) => ({ codeGraphId: s.codeGraphId, repoConnectorId: null }),
    (repository, dir) => `${repository?.codeGraphId ?? ""}\u0000${dir}`,
  );
  const graphsOfDir = new Map<string, Set<string>>();
  for (const m of grouped) {
    const graphs = graphsOfDir.get(m.dir) ?? new Set<string>();
    graphs.add(m.repository?.codeGraphId ?? "");
    graphsOfDir.set(m.dir, graphs);
  }
  const kept = includeTests ? grouped : excludeTestFiles(grouped).modules;
  return {
    modules: kept.map((m) => ({
      dir: m.dir,
      codeGraphId: m.repository?.codeGraphId ?? "",
      syms: m.syms,
    })),
    sharedDirs: new Set([...graphsOfDir].filter(([, g]) => g.size > 1).map(([dir]) => dir)),
  };
}

/**
 * The project's plan, reused while its index is unchanged (for at most
 * {@link COST_PLAN_TTL_MS}). Concurrent estimates share one read; a failed
 * read is not kept.
 */
async function projectPlan(projectId: string): Promise<ProjectPlan> {
  const includeTests = resolvePhase1IncludeTests();
  const graphs = await prisma.codeGraph.findMany({
    where: { projectId },
    select: { id: true, updatedAt: true, symbolCount: true },
    orderBy: { id: "asc" },
  });
  const key = JSON.stringify([
    projectId,
    includeTests,
    graphs.map((g) => [g.id, g.updatedAt.getTime(), g.symbolCount]),
  ]);
  const now = Date.now();
  const held = projectPlans.get(key);
  if (held && now - held.at < COST_PLAN_TTL_MS) return held.plan;
  for (const [k, v] of projectPlans) if (now - v.at >= COST_PLAN_TTL_MS) projectPlans.delete(k);
  while (projectPlans.size >= COST_PLAN_CACHE_MAX) {
    projectPlans.delete(projectPlans.keys().next().value!);
  }
  const plan = readProjectPlan(projectId, includeTests);
  projectPlans.set(key, { at: now, plan });
  plan.catch(() => {
    if (projectPlans.get(key)?.plan === plan) projectPlans.delete(key);
  });
  return plan;
}

/** The scope's documentable modules: the generator's grouping, test policy and path scope. */
export async function loadCostPlanModules(input: {
  projectId: string;
  codeGraphId?: string;
  pathPrefixes?: readonly string[];
  phase1Model: string;
  phase1PromptVersion: number;
}): Promise<CostPlanModule[]> {
  const plan = await projectPlan(input.projectId);
  const modules = plan.modules.filter(
    (m) => !input.codeGraphId || m.codeGraphId === input.codeGraphId,
  );
  if (input.pathPrefixes?.length && modules.length > 0) {
    try {
      // Narrows `modules` in place (a copy: the cached plan is never changed).
      restrictToPathScope(input.pathPrefixes, {
        modules,
        symbols: [],
        meta: { totalFiles: 0, totalSymbols: 0 },
      });
    } catch (err) {
      if (err instanceof PathScopeEmptyError) return [];
      throw err;
    }
  }
  if (modules.length === 0) return [];
  // Modules with facts under the model and prompt Phase 1 would use. The rows
  // are the project's own: the fact cache is keyed by project.
  const cachedRows = await prisma.docsGenFactCache.findMany({
    where: {
      projectId: input.projectId,
      model: input.phase1Model,
      promptVersion: input.phase1PromptVersion,
    },
    select: { modulePath: true },
    distinct: ["modulePath"],
  });
  const cached = new Set(cachedRows.map((r) => r.modulePath));
  return modules.map((m) => ({
    lines: moduleSourceLines(m.syms),
    cached: cached.has(m.dir) && !plan.sharedDirs.has(m.dir),
  }));
}

/** The plan's run-wide settings, as the generator resolves them. */
export function costPlanSettings(input: {
  phase1FactsMaxOutputTokens: number;
  factsCharCap: number;
}): Pick<CostPlan, "documentMaxChars" | "factsCharCap" | "phase1ChunkInputChars"> {
  return {
    documentMaxChars: resolveDocumentMaxChars(),
    factsCharCap: input.factsCharCap,
    phase1ChunkInputChars: phase1ChunkLimits(
      input.phase1FactsMaxOutputTokens,
      resolvePhase1ChunkInputTokens(),
    ).inputChars,
  };
}

/**
 * The estimate for a business-requirements document of one scope: the whole
 * project, or one repository's code graph, optionally narrowed to path
 * prefixes. `models` and the provider settings come from
 * `resolveDocsGenCostInputs` (holistic-synthesizer.ts), `sections` from the
 * document type's section groups.
 */
export async function estimateBrdGenerationCost(input: {
  projectId: string;
  codeGraphId?: string;
  pathPrefixes?: readonly string[];
  sections: number;
  models: CostModels;
  factsCharCap: number;
  phase1FactsMaxOutputTokens: number;
  phase1PromptVersion: number;
}): Promise<GenerationCostEstimate> {
  const modules = await loadCostPlanModules({
    projectId: input.projectId,
    codeGraphId: input.codeGraphId,
    pathPrefixes: input.pathPrefixes,
    phase1Model: input.models.phase1.model,
    phase1PromptVersion: input.phase1PromptVersion,
  });
  if (modules.length === 0) return noCodeEstimate(input.sections);
  return estimateFromPlan(
    {
      modules,
      sections: input.sections,
      ...costPlanSettings({
        phase1FactsMaxOutputTokens: input.phase1FactsMaxOutputTokens,
        factsCharCap: input.factsCharCap,
      }),
    },
    input.models,
  );
}

/** The plan summary of a scope with nothing to document. */
export function noCodeEstimate(sections: number): GenerationCostEstimate {
  return {
    status: "no-code",
    lowUsd: null,
    highUsd: null,
    models: [],
    unpricedModels: [],
    freeModels: [],
    plan: {
      modules: 0,
      modulesToExtract: 0,
      sourceLines: 0,
      sections,
      modelCalls: 0,
      estimatedDocumentChars: 0,
    },
  };
}
