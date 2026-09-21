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
  type AnalysisAgentKey,
  type FindingSupportPanel,
  type RequirementPriority,
  type SynthesisDegradation,
  type SynthesisDegradationReason,
  type SynthesisOutput,
  synthesisOutputSchema,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { clampToModelOutputCeiling } from "../ai/model-output-limits.js";
import { getConfigService } from "../config/config-service.js";
import { ConfigValidationError } from "../config/errors.js";
// #1226 owns the single table of provider stop signals that mean "the OUTPUT
// cap fired" (`length` on the OpenAI-compatible wire format, `max_tokens` on
// Anthropic's). Imported rather than re-listed — a second copy would drift, and
// the module is a dependency-free leaf despite living under `docs-gen/`.
import { isTruncationFinishReason } from "../docs-gen/truncation.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import { buildSynthesisPrompt } from "./prompts.js";

const log = createChildLogger("analysis-synthesis");

export interface FlatFinding extends AgentFindingPayload {
  agentKey: AnalysisAgentKey;
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
function readConfiguredSynthesisMaxOutputTokens(): number {
  const cfg = getConfigService();
  const raw = cfg.get(SYNTHESIS_MAX_OUTPUT_TOKENS_KEY);
  if (raw === undefined) return DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS;

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
  return clampToModelOutputCeiling(readConfiguredSynthesisMaxOutputTokens(), model, undefined, {
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

export const formatFindingsTable = (findings: FlatFinding[]): string => {
  if (findings.length === 0) return "(no findings)";
  return findings
    .map((f, i) => {
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
      output: { summary: "No findings produced by specialist agents.", requirements: [] },
      usage: DEFAULT_USAGE,
      durationMs: Date.now() - start,
    };
  }
  const { systemMessage, userMessage } = buildSynthesisPrompt({
    projectName: input.projectName,
    findingsTable: formatFindingsTable(input.findings),
    refinedRequirements: input.refinedRequirements,
    affectedSchema: input.affectedSchema,
    // #1110 — the panel rule is added only when a panel actually ran, so a
    // flag-off run sends a byte-identical system prompt to a pre-#1109 one.
    panelGuidance: hasPanelSignal(input.findings),
  });
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  log.info("Synthesis run starting", { findingCount: input.findings.length });

  // Usage accumulates across attempts: a retried run really did spend the
  // tokens of the attempt that failed, and the cost accounting must say so.
  const usage: TokenUsage = { ...DEFAULT_USAGE };
  const addUsage = (u: TokenUsage | undefined): void => {
    if (!u) return;
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    usage.totalTokens += u.totalTokens;
  };

  let failure: { reason: SynthesisDegradationReason; detail?: string } | null = null;
  let attempts = 0;

  // #1223 — an EXPLICIT output cap. Left unset this inherited whatever the
  // provider defaults to (16,000 on `anthropic`, 4096 on the
  // OpenAI-compatible/Bedrock class), and on the configured provider that was
  // not enough: thinking tokens spend the same budget as the answer, so the
  // reconciled requirement set came back cut off mid-JSON and every run
  // degraded to the deterministic fallback with `reason: non-json`.
  // #1257 — resolved against the model AND the provider this call will actually
  // run on: `provider.chat` is non-streaming, so the cap is additionally bounded
  // by what the Anthropic SDK agrees to send. `provider.model` is the fallback
  // because that is what the adapter uses when `input.model` is unset.
  const maxOutputTokens = resolveSynthesisMaxOutputTokens(
    input.model ?? provider.model,
    provider.key,
  );

  for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt++) {
    attempts = attempt;
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
      failure = { reason: "provider-error", detail: (err as Error).message };
      break;
    }

    let parsed: unknown;
    try {
      parsed = extractJsonObject(raw);
    } catch (err) {
      // #1223 — the log line this replaces carried the reason and nothing else,
      // which could not separate the three candidate causes from one another.
      // `finishReason` settles the first outright, and the TAIL settles it a
      // second way: a cap-truncated payload simply stops mid-token, where a
      // model that wrapped its JSON in prose ends with prose.
      const capTruncated = isTruncationFinishReason(finishReason);
      log.warn("Synthesis response was not parseable JSON", {
        attempt,
        finishReason: finishReason ?? "unknown",
        capTruncated,
        maxOutputTokens,
        contentLength: raw.length,
        parseError: (err as Error).message,
        contentHead: raw.slice(0, 300),
        contentTail: raw.slice(-300),
        ...(capTruncated
          ? {
              hint: "Raise ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS, or lower it if the model rejects the request outright.",
            }
          : {}),
      });
      failure = {
        reason: "non-json",
        // The stop signal leads so `truncateDetail` can never cut it away, and
        // so the reader of the persisted degradation — the analysis page's
        // #1117 notice — sees the cause before the parser's symptom.
        detail:
          `finishReason=${finishReason ?? "unknown"}` +
          `${capTruncated ? " (output-cap truncation)" : ""}: ${(err as Error).message}`,
      };
      if (attempt < MAX_SYNTHESIS_ATTEMPTS) continue;
      break;
    }

    const validation = synthesisOutputSchema.safeParse(parsed);
    if (!validation.success) {
      failure = {
        reason: "schema-invalid",
        detail: JSON.stringify(validation.error.flatten().fieldErrors),
      };
      if (attempt < MAX_SYNTHESIS_ATTEMPTS) continue;
      break;
    }

    // Clamp evidence indexes to valid range \u2014 the model occasionally invents
    // findings.
    const sanitized: SynthesisOutput = {
      summary: validation.data.summary,
      requirements: validation.data.requirements.map((r) => ({
        ...r,
        evidenceFindingIndexes: r.evidenceFindingIndexes.filter(
          (i) => Number.isInteger(i) && i >= 0 && i < input.findings.length,
        ),
      })),
    };

    // If the model returned zero requirements but the deterministic fallback
    // would have produced some, prefer the fallback so we never hand the user
    // an empty Requirements tab on a populated finding set.
    if (sanitized.requirements.length === 0 && input.findings.length > 0) {
      failure = { reason: "empty-requirements" };
      break;
    }

    return { output: sanitized, usage, durationMs: Date.now() - start };
  }

  // Every path out of the loop that reaches here degraded. `failure` is always
  // set on those paths; the fallback keeps the run useful, and `degraded` is
  // what stops it from presenting as a clean success.
  const reason = failure?.reason ?? "empty-requirements";
  const output = fallbackSynthesize(input.findings);
  const degraded: SynthesisDegradation = {
    reason,
    ...(failure?.detail ? { detail: truncateDetail(failure.detail) } : {}),
    attempts,
    requirementCount: output.requirements.length,
    at: new Date().toISOString(),
  };
  log.warn("Synthesis degraded to the deterministic fallback", {
    reason,
    attempts,
    retryable: RETRYABLE_REASONS.has(reason),
    requirementCount: output.requirements.length,
    // #1223 — `detail` now leads with the provider's own stop signal on the
    // parse-failure path, so this line is diagnosable without correlating it
    // against the per-attempt warning above.
    maxOutputTokens,
    detail: degraded.detail,
  });
  return { output, usage, durationMs: Date.now() - start, degraded };
}
