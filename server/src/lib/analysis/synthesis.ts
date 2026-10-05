/**
 * Synthesis (LLM reviewer) agent for the multi-agent pipeline (Phase 7 / #56).
 *
 * Receives the merged finding list, asks the LLM to dedupe / prioritise /
 * structure them as Requirements, then validates the JSON output against the
 * shared `synthesisOutputSchema`. The output is enriched with deterministic
 * fallback rules (priority inference + dedup by title cosine) so a model
 * that emits sparse output still yields useful Requirements.
 */
import {
  describeSupportPanel,
  type AgentFindingPayload,
  type AnalysisResultAgentKey,
  type FindingSupportPanel,
  type RequirementPriority,
  type SynthesisDegradation,
  type SynthesisDegradationReason,
  type SynthesisOutput,
  synthesisOutputSchema,
  synthesizedRequirementSchema,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { clampToModelOutputCeiling } from "../ai/model-output-limits.js";
import { boundNonStreamingOutputTokens } from "../ai/nonstreaming-output-bound.js";
import { getConfigService } from "../config/config-service.js";
import { ConfigValidationError } from "../config/errors.js";
// #1226 owns the single table of provider stop signals that mean "the OUTPUT
// cap fired" (`length` on the OpenAI-compatible wire format, `max_tokens` on
// Anthropic's). Imported rather than re-listed — a second copy would drift, and
// the module is a dependency-free leaf despite living under `docs-gen/`.
import { isTruncationFinishReason } from "../docs-gen/truncation.js";
// #751 — the ONE allow-list of models that reason by default from the same
// output budget, and the allowance granted them. Imported, not re-listed: a
// second copy is how the synthesis cap was missed when docs-gen got it.
import { reasoningAllowanceTokens } from "../docs-gen/output-caps.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import { buildSynthesisPrompt } from "./prompts.js";
import { salvageSynthesisPrefix } from "./synthesis-salvage.js";

const log = createChildLogger("analysis-synthesis");

export interface FlatFinding extends AgentFindingPayload {
  /** A specialist key, or (#289) the ref of the agent-phase agent that made it. */
  agentKey: AnalysisResultAgentKey;
}

export interface SynthesisInput {
  projectName: string;
  findings: FlatFinding[];
  signal?: AbortSignal;
  model?: string;
  /**
   * Epic #201 (#212) — clarification-refined requirements persisted in
   * `Analysis.metadata`. When present, they are injected into the synthesis
   * prompt as authoritative, human-clarified context so answering clarifying
   * questions measurably changes the generated requirement set.
   */
  refinedRequirements?: RefinedRequirementInput[];
  /**
   * #824 (Epic #820 Phase 1) — the deterministic AFFECTED SCHEMA block (#823).
   * When present, synthesis reconciles each requirement's code + schema findings
   * into one requirement (feeds 1f/#826). Empty/undefined ⇒ the section is
   * omitted and the prompt is byte-identical to the pre-#824 behaviour.
   */
  affectedSchema?: string;
}

/** A single clarification-refined requirement passed into synthesis (#212). */
export interface RefinedRequirementInput {
  title: string;
  description: string;
}

export interface SynthesisRunResult {
  output: SynthesisOutput;
  usage: TokenUsage;
  durationMs: number;
  /**
   * Issue #1117 (findings B + C) — set when `output` came from
   * {@link fallbackSynthesize} rather than the model. Absent on a normal run.
   *
   * The fallback is a keyword clusterer: it cannot classify, so it emits
   * `type: "feature"` and `acceptanceCriteria: []` for every requirement it
   * produces. That is a large, visible change to the run's output, and until
   * this field existed the ONLY trace of it was a log line and the fallback's
   * own summary string buried in a persisted JSON blob. A walkthrough filed the
   * two symptoms as two separate defects with two separate wrong theories.
   */
  degraded?: SynthesisDegradation;
  /**
   * #751 — present when the run needed more than one model call: how many
   * calls it made, how many replies were salvaged from an output-cap
   * truncation, and how many times a finding set was split because a reply
   * held nothing salvageable. Absent on a single clean call.
   */
  recovery?: SynthesisRecovery;
}

/** #751 — how a multi-call synthesis got its answer. */
export interface SynthesisRecovery {
  calls: number;
  salvagedResponses: number;
  splits: number;
}

/**
 * How many LLM attempts synthesis makes before degrading.
 *
 * Set to 2 because the failure this fixes is a SINGLE malformed response
 * costing an entire run its requirement typing and acceptance criteria — in the
 * run that filed #1117 the document specialist independently emitted unparseable
 * JSON in the same session, so a transient bad completion is the observed mode
 * here, not a systematic one. Only the recoverable reasons retry: a provider
 * error is the caller's problem (cost cap, auth, abort) and re-asking a model
 * that answered with zero requirements tends to get zero requirements again.
 */
const MAX_SYNTHESIS_ATTEMPTS = 2;

const RETRYABLE_REASONS: ReadonlySet<SynthesisDegradationReason> = new Set([
  "non-json",
  "schema-invalid",
]);

/**
 * #751 — the most model calls one synthesis run may make, across retries,
 * continuations after a truncation, and split halves.
 *
 * A thinking model (DeepSeek `deepseek-flash`) spends its reasoning from the
 * same output cap as its answer, and on the `anthropic` provider that cap
 * cannot be raised: `chat()` is non-streaming and the SDK refuses more than
 * 21,333 (#1257). So a requirement set that does not fit one reply is written
 * in pieces instead — the complete requirements of a truncated reply are kept,
 * and the next call is asked only for the findings they do not cover.
 *
 * Six bounds the worst case at six capped replies (~126k output tokens at
 * 21,000) while leaving room for the cases measured: run 3's 29 requirements
 * need two calls, and a table whose reasoning alone fills the cap needs one
 * split (two halves) plus a possible continuation. When the budget runs out the
 * findings no call reached are grouped by the deterministic fallback, and the
 * run is marked degraded — but the requirements the model DID write are kept.
 */
export const MAX_SYNTHESIS_CALLS = 6;

/**
 * #1223 — the ceiling on a NON-STREAMING Anthropic request, imposed by the SDK
 * itself rather than by the API.
 *
 * #1257 moved the derivation to `ai/nonstreaming-output-bound.ts`, which is
 * where the SDK's own arithmetic is reproduced and pinned against the installed
 * SDK, and where the ENFORCEMENT now lives — this constant had documented the
 * bound without any code holding a request to it. Re-exported under the same
 * name because the number is quoted in the config registry and in #1223's tests.
 */
export { ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS } from "../ai/nonstreaming-output-bound.js";

/**
 * #1223 — default OUTPUT cap for one synthesis call.
 *
 * Sits deliberately between two measured bounds. Above 16,000, which is
 * `AnthropicProvider`'s `DEFAULT_MAX_TOKENS` and therefore the cap synthesis
 * silently inherited: across five live calls on a real 26-finding table it
 * truncated two outright, and the three that completed cleared it by as little
 * as 1,276 tokens. Below {@link ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS},
 * which no non-streaming call on this provider may cross at all.
 *
 * The binding cost is not the JSON. That measured ~5–6k tokens; `thinking`
 * consumed 5,088–9,763 of the SAME budget, varying run to run, which is why the
 * failure presented as "every run" rather than as an edge case.
 */
export const DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS = 21_000;

/**
 * The knob that carries this cap. Exported so the startup check can name it.
 *
 * A knob rather than a constant for the reason #1224 gave the sibling agent
 * cap: a model whose own output ceiling is below the default rejects the
 * request outright with a 400, turning a working call into a failing one. An
 * operator serving such a model lowers this; nobody should need to raise it,
 * and since #1257 raising it past {@link ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS}
 * on the Anthropic path is clamped and warned about rather than left to throw.
 *
 * Deliberately NOT shared with `ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS`
 * (#1218/#1224). That knob defaults to 16,384 — measured insufficient here,
 * since 16,000 already truncated — and it bounds a different payload: one
 * agent's findings, not the whole run's reconciled requirement set.
 */
export const SYNTHESIS_MAX_OUTPUT_TOKENS_KEY = "ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS";

/**
 * #1257 — read the knob through the registry's OWN schema rather than through
 * `getNumber`'s silent fallback, exactly as #1221 did for the sibling key.
 *
 * `getNumber` parsed with `Number.parseInt` and swallowed failures, so `"0"` and
 * `"-5"` were returned verbatim and became a `maxTokens` the provider rejects at
 * request time, while `"21000abc"` truncated to a number that looked deliberate.
 * The registry entry is already `z.coerce.number().int().positive()`, so
 * validating through it means ONE statement of what a legal value is.
 */
function readConfiguredSynthesisMaxOutputTokens(): number | undefined {
  const cfg = getConfigService();
  const raw = cfg.get(SYNTHESIS_MAX_OUTPUT_TOKENS_KEY);
  if (raw === undefined) return undefined;

  const def = cfg.getKeyDef(SYNTHESIS_MAX_OUTPUT_TOKENS_KEY);
  const parsed = def?.schema.safeParse(raw);
  if (!parsed?.success) {
    throw new ConfigValidationError(
      SYNTHESIS_MAX_OUTPUT_TOKENS_KEY,
      parsed?.error.flatten() ?? `no registry entry for ${SYNTHESIS_MAX_OUTPUT_TOKENS_KEY}`,
    );
  }
  // Narrowing, not a second rule: the schema decides validity.
  const value: unknown = parsed.data;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigValidationError(
      SYNTHESIS_MAX_OUTPUT_TOKENS_KEY,
      `schema produced a non-numeric value for ${SYNTHESIS_MAX_OUTPUT_TOKENS_KEY}`,
    );
  }
  return value;
}

/**
 * #1257 — startup gate for {@link SYNTHESIS_MAX_OUTPUT_TOKENS_KEY}, the second
 * of the two items #1223 declined to reach into #1221's files for mid-flight.
 *
 * Called from `server/src/index.ts` so a non-positive or non-numeric value is
 * rejected at boot, where it reads as the config error it is, rather than at the
 * end of a multi-agent analysis run — the single most expensive moment in the
 * product to discover a typo. Throws `ConfigValidationError`.
 */
export function assertSynthesisMaxOutputTokensValid(): void {
  readConfiguredSynthesisMaxOutputTokens();
}

/**
 * The configured OUTPUT cap for a synthesis call, held at what the model and the
 * transport will actually accept.
 *
 * @param model the model the request will run on (`input.model ?? provider.model`).
 * @param providerKey the provider it will run on. Synthesis calls
 *   `provider.chat`, which is NON-streaming, so the SDK's client-side bound
 *   (#1257) applies on the `anthropic` provider.
 */
export function resolveSynthesisMaxOutputTokens(
  model?: string | null,
  providerKey?: string | null,
): number {
  const configured = readConfiguredSynthesisMaxOutputTokens();
  let requested = configured ?? DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS;
  if (configured === undefined) {
    // #751 — a model that reasons by default spends that reasoning from this
    // same cap, so the DEFAULT grows by docs-gen's reasoning allowance (#25)
    // for exactly those models. An operator's explicit value is used as given.
    //
    // The transport bound is applied here, silently, before the clamp below:
    // on the `anthropic` provider (DeepSeek's endpoint included) the SDK will
    // not send more than 21,333 non-streaming, and the clamp's warning names
    // the knob as if the operator had set it too high — they set nothing.
    // That bound is why the allowance alone cannot fix #751 on that provider,
    // and why `runSynthesis` recovers from a truncation instead.
    const allowance = reasoningAllowanceTokens(model ?? undefined);
    if (allowance > 0) {
      const silent = { warn: (): void => undefined };
      requested = Math.max(
        requested,
        boundNonStreamingOutputTokens(requested + allowance, providerKey, {
          logger: silent,
          model,
        }).value,
      );
    }
  }
  return clampToModelOutputCeiling(requested, model, undefined, {
    // #1257 — was NOT wired into this clamp at all, and #1223 declined to do it
    // mid-flight because the warning named the OTHER key literally. It now
    // names whichever knob the caller passes.
    knob: SYNTHESIS_MAX_OUTPUT_TOKENS_KEY,
    ...(providerKey != null ? { nonStreamingProviderKey: providerKey } : {}),
  }).value;
}

/** Keep a provider/parser message useful but bounded before it is persisted. */
const truncateDetail = (detail: string): string =>
  detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;

const DEFAULT_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/**
 * Epic #1107 (#1110) — **ranking note.** Findings reach `runSynthesis` already
 * ordered by the #1109 panel's confidence: `orderByPanelConfidence` (in
 * `@metis/shared`) is applied by `runSynthesisAndPersist` before the rows are
 * numbered, so a low-confidence finding competes for attention last — while
 * still being present, in full, in the table below. It is a SORT, never a
 * filter; nothing in this pipeline removes a finding (#1101).
 *
 * `runSynthesis` deliberately does NOT sort internally. `formatFindingsTable`
 * numbers rows `[0]…[N]` and the model answers with `evidenceFindingIndexes`
 * against those numbers, so the finding-id array `persistRequirements` resolves
 * them through must come from the same ordering. Only the caller holds both
 * arrays, so only the caller can safely reorder — sorting here would silently
 * mis-attribute evidence.
 */

/**
 * The panel's contribution to one table row: a prefix marker for the two states
 * the model must down-weight, and a compact tally tail for every state.
 *
 * `low` and `no-signal` get DIFFERENT markers on purpose. "The panel doubts this"
 * and "the panel could not judge this" call for different behaviour from the
 * model — the first is grounds to down-weight, the second is grounds to treat the
 * finding exactly as it would have been treated without a panel at all.
 *
 * Returns two empty strings when no panel ran, which is what makes a flag-off run
 * render byte-identically to a pre-#1109 one.
 */
function panelMarks(panel: FindingSupportPanel | null | undefined): {
  prefix: string;
  tail: string;
} {
  const summary = describeSupportPanel(panel);
  if (!summary || !panel) return { prefix: "", tail: "" };
  // #1111 — an UNEXAMINED absence claim gets its own prefix because no existing
  // one covers it: it is capped at `medium`, so it arrives unmarked today, and
  // synthesis is the step that turns "X is not implemented" into "build X". A
  // CONTRADICTED claim is forced to `low` and needs no second marker.
  const prefix =
    summary.confidence === "low"
      ? "[LOW-CONFIDENCE] "
      : summary.absence?.unexamined
        ? "[ABSENCE-UNEXAMINED] "
        : summary.confidence === "no-signal"
          ? "[UNJUDGED] "
          : "";
  const dissent = summary.dissent.map((d) => d.lens).join(", ");
  const tail =
    ` :: panel=${summary.confidence} ${summary.supportedVotes}/${summary.countedVotes}` +
    (dissent ? ` (dissent: ${dissent})` : "") +
    (summary.absence ? ` absence=${summary.absence.verdict ?? "not-checked"}` : "");
  return { prefix, tail };
}

export const formatFindingsTable = (
  findings: FlatFinding[],
  /**
   * #751 — render only these rows, under their ORIGINAL indexes, for a
   * continuation call. The model answers with `evidenceFindingIndexes`, so the
   * numbers must still resolve against the full list. Omitted ⇒ every row.
   */
  indexes?: readonly number[],
): string => {
  if (findings.length === 0) return "(no findings)";
  return (indexes ?? findings.map((_, i) => i))
    .map((i) => {
      const f = findings[i]!;
      // #740 — prefix `unverified` findings with an explicit [UNVERIFIED] marker
      // so the synthesis model down-weights claims whose code evidence failed the
      // #734 grounding gate (rule 4 in buildSynthesisPrompt). `confirmed`/`null`
      // findings are unmarked, so the marker's presence alone is the signal.
      const mark = f.verificationStatus === "unverified" ? "[UNVERIFIED] " : "";
      // #1110 — the panel marker STACKS with the verification one rather than
      // replacing it: the deterministic gate asks "was this file retrieved?" and
      // the panel asks "does it back the claim?". A finding can fail either.
      const { prefix, tail } = panelMarks(f.supportPanel);
      return `[${i}] ${mark}${prefix}(${f.agentKey} / ${f.severity} / ${f.category}) ${f.title} :: ${f.body} :: tags=${f.tags.join(",")}${tail}`;
    })
    .join("\n");
};

/** Does any finding carry a panel? Gates the panel rule in the synthesis prompt. */
export const hasPanelSignal = (findings: readonly FlatFinding[]): boolean =>
  findings.some((f) => Boolean(f.supportPanel));

/**
 * Token-set Jaccard similarity over normalised titles. Cheap, deterministic,
 * and good enough to catch \"data retention\" vs \"audit log retention\" without
 * pulling in a real embedding model just for dedup.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Priority rules per research \u00a75: compliance OR critical severity =>
 * critical; security OR high => high; medium => medium; info => low.
 */
export function inferPriority(findings: FlatFinding[]): RequirementPriority {
  const hasCompliance = findings.some(
    (f) => f.category === "compliance" || f.tags.some((t) => /^compliance$/i.test(t)),
  );
  const hasCritical = findings.some((f) => f.severity === "critical");
  if (hasCompliance || hasCritical) return "critical";
  const hasSecurity = findings.some((f) => f.category === "security");
  const hasHigh = findings.some((f) => f.severity === "high");
  if (hasSecurity || hasHigh) return "high";
  if (findings.some((f) => f.severity === "medium")) return "medium";
  return "low";
}

const TAG_OVERLAP = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map((t) => t.toLowerCase()));
  let n = 0;
  for (const t of b) if (sa.has(t.toLowerCase())) n += 1;
  return n;
};

/**
 * Deterministic fallback used when the model returns no requirements (or is
 * the offline stub). Groups findings by tag-overlap + title similarity and
 * emits one Requirement per cluster.
 */
export function fallbackSynthesize(
  findings: FlatFinding[],
  similarityThreshold = 0.4,
): SynthesisOutput {
  const remaining = findings.map((f, idx) => ({ f, idx, used: false }));
  const requirements: SynthesisOutput["requirements"] = [];

  for (const seed of remaining) {
    if (seed.used) continue;
    seed.used = true;
    const cluster: typeof remaining = [seed];
    for (const cand of remaining) {
      if (cand.used) continue;
      const titleScore = titleSimilarity(seed.f.title, cand.f.title);
      const tagScore = TAG_OVERLAP(seed.f.tags, cand.f.tags);
      if (titleScore >= similarityThreshold || tagScore >= 2) {
        cand.used = true;
        cluster.push(cand);
      }
    }
    const clusterFindings = cluster.map((c) => c.f);
    const priority = inferPriority(clusterFindings);
    const labels = Array.from(
      new Set(clusterFindings.flatMap((c) => c.tags.map((t) => t.toLowerCase()))),
    ).slice(0, 16);
    const body = clusterFindings
      .map((c) => `(${c.agentKey}) ${c.body}`)
      .join("\n\n")
      .slice(0, 4000);
    requirements.push({
      type: "feature",
      title: seed.f.title.slice(0, 255),
      body,
      priority,
      labels,
      evidenceFindingIndexes: cluster.map((c) => c.idx),
      // Issue #1096 — this deterministic fallback clusters findings without a
      // model, so it cannot derive testable criteria. Empty is the truthful
      // answer; downstream renders "none were derived" rather than filler.
      acceptanceCriteria: [],
    });
    if (requirements.length >= 100) break;
  }

  return {
    summary: `Auto-synthesized ${requirements.length} requirement(s) from ${findings.length} finding(s).`,
    requirements,
  };
}

type SynthesizedRequirement = SynthesisOutput["requirements"][number];

/** #751 — a slice of the findings table one synthesis call is asked about. */
interface SynthesisSegment {
  /** Original indexes into `input.findings`, ascending. */
  indexes: number[];
  /** 1-based retry count for THIS slice; bounded by {@link MAX_SYNTHESIS_ATTEMPTS}. */
  attempt: number;
}

/** Caps a kept or merged requirement must stay inside (`synthesisOutputSchema`). */
const MAX_REQUIREMENTS = 100;
const MAX_EVIDENCE = 50;
const MAX_LABELS = 16;
const MAX_CRITERIA = 20;

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, " ");

const union = <T>(a: readonly T[], b: readonly T[], cap: number): T[] =>
  Array.from(new Set([...a, ...b])).slice(0, cap);

export async function runSynthesis(
  provider: AIProvider,
  input: SynthesisInput,
): Promise<SynthesisRunResult> {
  const start = Date.now();
  if (input.signal?.aborted) {
    throw new DOMException("Aborted before start", "AbortError");
  }
  if (input.findings.length === 0) {
    return {
      output: {
        summary: "No findings produced by specialist agents.",
        requirements: [],
      },
      usage: DEFAULT_USAGE,
      durationMs: Date.now() - start,
    };
  }
  const total = input.findings.length;

  log.info("Synthesis run starting", { findingCount: total });

  // Usage accumulates across calls: a retried, continued or split run really
  // did spend the tokens of every call, and the cost accounting must say so.
  // (Each call is ALSO metered individually to `token_usages` by the provider
  // decorator in `analysis-usage.ts`; this sum is the analysis's own total.)
  const usage: TokenUsage = { ...DEFAULT_USAGE };
  const addUsage = (u: TokenUsage | undefined): void => {
    if (!u) return;
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    usage.totalTokens += u.totalTokens;
  };

  // #1223 — an EXPLICIT output cap. Left unset this inherited whatever the
  // provider defaults to (16,000 on `anthropic`, 4096 on the
  // OpenAI-compatible/Bedrock class), and on the configured provider that was
  // not enough: thinking tokens spend the same budget as the answer.
  // #1257 — resolved against the model AND the provider this call will actually
  // run on: `provider.chat` is non-streaming, so the cap is additionally bounded
  // by what the Anthropic SDK agrees to send. `provider.model` is the fallback
  // because that is what the adapter uses when `input.model` is unset.
  // #751 — grown by the reasoning allowance for a thinking-by-default model.
  const maxOutputTokens = resolveSynthesisMaxOutputTokens(
    input.model ?? provider.model,
    provider.key,
  );

  const isValidIndex = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < total;

  // #751 — requirements kept so far, in the order the model wrote them.
  const kept: SynthesizedRequirement[] = [];
  /** Requirements kept by EARLIER calls, by normalised title (several may share one). */
  const keptByTitle = new Map<string, SynthesizedRequirement[]>();
  /**
   * #868 review — what the schema caps cut while keeping or merging. Never
   * dropped silently: logged at the end of the run, and named in the detail of
   * a degraded one.
   */
  const capDrops = {
    requirementsDropped: 0,
    evidenceLinksDropped: 0,
    acceptanceCriteriaDropped: 0,
  };
  /**
   * Keep one call's requirements. Evidence indexes are clamped to the table
   * (the model occasionally invents findings). A requirement that repeats one
   * kept from an EARLIER call is merged into it rather than duplicated — a
   * continuation is told what exists, but may still restate it. "Repeats" means
   * the normalised title matches AND the two cite at least one finding in
   * common: generic titles ("Input validation", "Error handling") recur across
   * split halves for unrelated findings, and fusing those would discard one
   * requirement's type and description and pin its criteria on the other.
   * Titles within one call are not merged: that is the model's own output, and
   * a single clean call must come back exactly as it always has.
   */
  const keep = (reqs: readonly SynthesizedRequirement[]): void => {
    const fromThisCall: Array<[string, SynthesizedRequirement]> = [];
    for (const r of reqs) {
      const clean = {
        ...r,
        evidenceFindingIndexes: r.evidenceFindingIndexes.filter(isValidIndex),
      };
      const key = normalizeTitle(clean.title);
      const evidence = new Set(clean.evidenceFindingIndexes);
      const prior = keptByTitle
        .get(key)
        ?.find((p) => p.evidenceFindingIndexes.some((i) => evidence.has(i)));
      if (prior) {
        const evidenceAll = new Set([
          ...prior.evidenceFindingIndexes,
          ...clean.evidenceFindingIndexes,
        ]);
        const criteriaAll = new Set([...prior.acceptanceCriteria, ...clean.acceptanceCriteria]);
        capDrops.evidenceLinksDropped += Math.max(0, evidenceAll.size - MAX_EVIDENCE);
        capDrops.acceptanceCriteriaDropped += Math.max(0, criteriaAll.size - MAX_CRITERIA);
        prior.evidenceFindingIndexes = union(
          prior.evidenceFindingIndexes,
          clean.evidenceFindingIndexes,
          MAX_EVIDENCE,
        );
        prior.labels = union(prior.labels, clean.labels, MAX_LABELS);
        prior.acceptanceCriteria = union(
          prior.acceptanceCriteria,
          clean.acceptanceCriteria,
          MAX_CRITERIA,
        );
        continue;
      }
      if (kept.length >= MAX_REQUIREMENTS) {
        capDrops.requirementsDropped += 1;
        continue;
      }
      kept.push(clean);
      fromThisCall.push([key, clean]);
    }
    for (const [key, r] of fromThisCall) {
      const list = keptByTitle.get(key);
      if (list) list.push(r);
      else keptByTitle.set(key, [r]);
    }
  };
  /** Indexes of `segment` that some KEPT requirement cites (after every cap). */
  const keptCitations = (segment: readonly number[]): Set<number> => {
    const cited = new Set(kept.flatMap((r) => r.evidenceFindingIndexes));
    return new Set(segment.filter((i) => cited.has(i)));
  };

  let summary: string | undefined;
  let failure: { reason: SynthesisDegradationReason; detail?: string } | null = null;
  let calls = 0;
  let salvagedResponses = 0;
  let splits = 0;
  /** Findings no successful call covered: the budget ran out, or a slice gave up. */
  const unreached: number[] = [];
  const queue: SynthesisSegment[] = [{ indexes: input.findings.map((_, i) => i), attempt: 1 }];

  const retryOrGiveUp = (segment: SynthesisSegment): void => {
    if (segment.attempt < MAX_SYNTHESIS_ATTEMPTS) {
      queue.unshift({ ...segment, attempt: segment.attempt + 1 });
    } else {
      unreached.push(...segment.indexes);
    }
  };

  while (queue.length > 0) {
    const segment = queue.shift()!;
    // #868 review — once the set holds MAX_REQUIREMENTS, no call can add a
    // requirement for these findings; spending one would only bill tokens.
    if (calls >= MAX_SYNTHESIS_CALLS || kept.length >= MAX_REQUIREMENTS) {
      unreached.push(...segment.indexes);
      continue;
    }
    calls += 1;
    const partialTable = segment.indexes.length < total;
    const segmentFindings = segment.indexes.map((i) => input.findings[i]!);
    const { systemMessage, userMessage } = buildSynthesisPrompt({
      projectName: input.projectName,
      // The first call renders the whole table exactly as before #751.
      findingsTable: formatFindingsTable(
        input.findings,
        partialTable ? segment.indexes : undefined,
      ),
      refinedRequirements: input.refinedRequirements,
      affectedSchema: input.affectedSchema,
      // #1110 — the panel rule is added only when a panel actually ran on a
      // finding in THIS table, so a flag-off run sends a byte-identical prompt.
      panelGuidance: hasPanelSignal(segmentFindings),
      ...(kept.length > 0 ? { alreadySynthesizedTitles: kept.map((r) => r.title) } : {}),
    });
    const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

    let raw: string;
    let finishReason: string | undefined;
    try {
      const response = await provider.chat(messages, {
        systemMessage,
        model: input.model,
        signal: input.signal,
        maxTokens: maxOutputTokens,
      });
      raw = response.content;
      finishReason = response.finishReason;
      addUsage(response.usage);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") throw err;
      // A provider error (cost cap, auth, outage) is not the model's output and
      // is not retried: stop calling, keep whatever earlier calls produced.
      failure = { reason: "provider-error", detail: (err as Error).message };
      unreached.push(...segment.indexes);
      for (const rest of queue.splice(0)) unreached.push(...rest.indexes);
      break;
    }

    let parsed: unknown;
    let parseError: Error | null = null;
    try {
      parsed = extractJsonObject(raw);
    } catch (err) {
      parseError = err as Error;
    }

    if (parseError === null) {
      const validation = synthesisOutputSchema.safeParse(parsed);
      if (!validation.success) {
        failure = {
          reason: "schema-invalid",
          detail: JSON.stringify(validation.error.flatten().fieldErrors),
        };
        retryOrGiveUp(segment);
        continue;
      }
      // Zero requirements for the WHOLE table means the model produced nothing
      // usable, and re-asking tends to get nothing again.
      if (validation.data.requirements.length === 0) {
        if (!partialTable) {
          failure = { reason: "empty-requirements" };
          break;
        }
        // #868 review — zero for a remainder or a split half leaves its
        // findings cited by NOTHING: a continuation is shown only uncovered
        // findings, and a half split off a reply that salvaged nothing has no
        // kept requirement to lean on. Accepting it as "covered" dropped them
        // with no degradation; they are unreached, so they reach the fallback
        // and the run says so.
        failure = {
          reason: "empty-requirements",
          detail: `a partial table of ${segment.indexes.length} finding(s) returned no requirements`,
        };
        unreached.push(...segment.indexes);
        continue;
      }
      summary ??= validation.data.summary;
      keep(validation.data.requirements);
      continue;
    }

    // #1223 — `finishReason` says whether the cap cut the reply off; the
    // detail leads with it so `truncateDetail` can never cut it away, and the
    // reader of the persisted degradation sees the cause before the symptom.
    const capTruncated = isTruncationFinishReason(finishReason);
    failure = {
      reason: "non-json",
      detail:
        `finishReason=${finishReason ?? "unknown"}` +
        `${capTruncated ? " (output-cap truncation)" : ""}: ${parseError.message}`,
    };

    // #751 — keep every requirement the reply completed before it broke off,
    // and ask again only for the findings those requirements do not cover.
    const salvage = salvageSynthesisPrefix(raw);
    const whole = salvage.requirements.flatMap((r) => {
      const v = synthesizedRequirementSchema.safeParse(r);
      return v.success ? [v.data] : [];
    });
    // #868 review — "covered" is decided by what was actually KEPT after the
    // requirement and evidence caps, not by everything salvaged: a requirement
    // the cap refused, or an evidence link a merge cut, covers nothing.
    // A salvage citing nothing in this segment is not kept at all (as before):
    // the segment is about to be split or re-asked, and would write it again.
    const inSegment = new Set(segment.indexes);
    const citesSegment = whole.some((r) => r.evidenceFindingIndexes.some((i) => inSegment.has(i)));
    const coveredBefore = keptCitations(segment.indexes);
    if (citesSegment) keep(whole);
    const coveredNow = keptCitations(segment.indexes);
    if (coveredNow.size > coveredBefore.size) {
      salvagedResponses += 1;
      if (salvage.summary) summary ??= salvage.summary;
      const rest = segment.indexes.filter((i) => !coveredNow.has(i));
      log.info("Synthesis reply was cut short; kept its complete requirements", {
        call: calls,
        finishReason: finishReason ?? "unknown",
        capTruncated,
        maxOutputTokens,
        salvagedRequirements: whole.length,
        coveredFindings: coveredNow.size,
        remainingFindings: rest.length,
      });
      if (rest.length > 0) queue.unshift({ indexes: rest, attempt: 1 });
      continue;
    }

    log.warn("Synthesis response was not parseable JSON", {
      call: calls,
      attempt: segment.attempt,
      finishReason: finishReason ?? "unknown",
      capTruncated,
      maxOutputTokens,
      findingCount: segment.indexes.length,
      contentLength: raw.length,
      parseError: parseError.message,
      contentHead: raw.slice(0, 300),
      contentTail: raw.slice(-300),
    });

    // #751 — a truncated reply with NOTHING whole in it spent the cap before
    // finishing one requirement (on a thinking model, mostly on reasoning). The
    // same table would do the same again; half of it reasons less and writes
    // less, so split it rather than retry it.
    if (capTruncated && segment.indexes.length > 1) {
      splits += 1;
      const mid = Math.ceil(segment.indexes.length / 2);
      queue.unshift(
        { indexes: segment.indexes.slice(0, mid), attempt: 1 },
        { indexes: segment.indexes.slice(mid), attempt: 1 },
      );
      continue;
    }
    retryOrGiveUp(segment);
  }

  const recovery: SynthesisRecovery | undefined =
    calls > 1 ? { calls, salvagedResponses, splits } : undefined;
  const withRecovery = recovery ? { recovery } : {};

  if (kept.length === 0) {
    // Nothing usable from any call. The fallback keeps the run useful, and
    // `degraded` is what stops it from presenting as a clean success.
    const reason = failure?.reason ?? "empty-requirements";
    const output = fallbackSynthesize(input.findings);
    const degraded: SynthesisDegradation = {
      reason,
      ...(failure?.detail ? { detail: truncateDetail(failure.detail) } : {}),
      attempts: calls,
      requirementCount: output.requirements.length,
      at: new Date().toISOString(),
    };
    log.warn("Synthesis degraded to the deterministic fallback", {
      reason,
      attempts: calls,
      retryable: RETRYABLE_REASONS.has(reason),
      requirementCount: output.requirements.length,
      maxOutputTokens,
      detail: degraded.detail,
    });
    return {
      output,
      usage,
      durationMs: Date.now() - start,
      degraded,
      ...withRecovery,
    };
  }

  const resolvedSummary =
    summary ?? `Synthesized ${kept.length} requirement(s) from ${total} finding(s).`;

  // #868 review — a cap that cut data is recorded, never silent.
  const logCapDrops = (extra: Record<string, number> = {}): void => {
    const all = { ...capDrops, ...extra };
    if (Object.values(all).some((n) => n > 0)) {
      log.warn("Synthesis output caps dropped data", {
        ...all,
        maxRequirements: MAX_REQUIREMENTS,
        maxEvidence: MAX_EVIDENCE,
        maxAcceptanceCriteria: MAX_CRITERIA,
      });
    }
  };

  if (unreached.length === 0) {
    logCapDrops();
    if (recovery) {
      log.info("Synthesis recovered across several calls", {
        ...recovery,
        requirementCount: kept.length,
        maxOutputTokens,
      });
    }
    return {
      output: { summary: resolvedSummary, requirements: kept },
      usage,
      durationMs: Date.now() - start,
      ...withRecovery,
    };
  }

  // #751 — PARTIAL: the model wrote some requirements, and some findings were
  // never reached (the call budget ran out, a slice gave up, or the provider
  // failed). Keep the model's requirements — discarding typed requirements with
  // acceptance criteria to group everything by keyword would be the #751
  // failure again — and group ONLY the unreached findings deterministically, so
  // nothing is dropped. The run is still marked degraded, and the detail says
  // which requirements are which.
  const orderedUnreached = [...new Set(unreached)].sort((a, b) => a - b);
  const allGrouped = fallbackSynthesize(
    orderedUnreached.map((i) => input.findings[i]!),
  ).requirements.map((r) => ({
    ...r,
    evidenceFindingIndexes: r.evidenceFindingIndexes.map((j) => orderedUnreached[j]!),
  }));
  const grouped = allGrouped.slice(0, Math.max(0, MAX_REQUIREMENTS - kept.length));
  const groupedRequirementsDropped = allGrouped.length - grouped.length;
  // Findings the requirement cap shut out of BOTH the model's set and the
  // keyword groups: represented by no requirement at all.
  const represented = new Set([...kept, ...grouped].flatMap((r) => r.evidenceFindingIndexes));
  const findingsShutOut = orderedUnreached.filter((i) => !represented.has(i)).length;
  logCapDrops({ groupedRequirementsDropped, findingsShutOut });
  const capNote =
    findingsShutOut > 0
      ? `The ${MAX_REQUIREMENTS}-requirement cap was reached, so ${findingsShutOut} finding(s) ` +
        `are in no requirement. `
      : "";
  const reason = failure?.reason ?? "non-json";
  const degraded: SynthesisDegradation = {
    reason,
    detail: truncateDetail(
      (
        `partial: ${kept.length} model-written requirement(s) kept; ` +
        `${orderedUnreached.length} finding(s) no call reached were grouped deterministically ` +
        `into ${grouped.length}. ${capNote}${failure?.detail ?? ""}`
      ).trimEnd(),
    ),
    attempts: calls,
    requirementCount: grouped.length,
    // #751 — lets the banner say which requirements are model-written.
    modelRequirementCount: kept.length,
    at: new Date().toISOString(),
  };
  log.warn("Synthesis partially degraded: unreached findings grouped deterministically", {
    reason,
    attempts: calls,
    keptRequirements: kept.length,
    unreachedFindings: orderedUnreached.length,
    groupedRequirements: grouped.length,
    maxOutputTokens,
    detail: degraded.detail,
  });
  return {
    output: { summary: resolvedSummary, requirements: [...kept, ...grouped] },
    usage,
    durationMs: Date.now() - start,
    degraded,
    ...withRecovery,
  };
}
