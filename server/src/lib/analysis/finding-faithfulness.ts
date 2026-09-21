/**
 * Epic #1316 / Issue #1318 — one faithfulness number for the analysis pipeline.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `grep -rl "FaithfulnessJudge\|scoreFaithfulness" server/src` returned no file
 * under `server/src/lib/analysis/`. The pipeline that produces the findings
 * operators publish to Jira had NO faithfulness number at all — only the #740
 * deterministic gate's categorical `confirmed` / `unverified` /
 * `could-not-verify`, which answers *"was this locator retrieved?"* and
 * structurally cannot answer *"does the retrieved text BACK the claim?"*.
 *
 * docs-gen has answered the second question since #273 with claim decomposition
 * plus NLI entailment. This module points analysis at the SAME substrate through
 * the shared {@link scoreEvidenceFaithfulness} (#1317), so the two pipelines
 * report one comparable number rather than two incomparable signals. There is no
 * third judging stack here: every model call this module causes is made by
 * `ClaimExtractor` and `FaithfulnessJudge`, unchanged.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is not a gate, and it is not the support panel. Per #1109 the panel is a
 * GRADER: it writes `supportPanel` and must never touch `verificationStatus`.
 * The same rule binds this module, harder — it writes ONE new optional field and
 * reads nothing back. No verdict, no severity, no ranking and no deletion
 * depends on it. `finding-verification.ts` is not imported here and must not be:
 * that is what makes "the categorical gate is byte-for-byte unchanged" a
 * STRUCTURAL claim rather than a promise, and `finding-faithfulness-additive.
 * test.ts` asserts the import edge does not exist.
 *
 * ── FLAG OFF ⇒ BYTE-IDENTICAL ───────────────────────────────────────────────
 *
 * `ANALYSIS_FAITHFULNESS_METRIC` defaults OFF. When off no provider call is made
 * and the findings array is returned untouched — the field is ABSENT, not
 * `null`, so a flag-off run persists exactly as a pre-#1318 run did.
 *
 * ── UNVERIFIABLE IS NOT A SCORE ─────────────────────────────────────────────
 *
 * `score === null` means the judge could not decide (offline provider, no
 * retrieved evidence, no atomic claims, an unusable verdict set). It is excluded
 * from aggregates, never counted as a pass. A metric that read 1.0 whenever it
 * failed would report the product healthiest exactly when the judge was down —
 * the `StubRagasJudge` defect #1317 exists to remove.
 *
 * SECURITY. Finding bodies and retrieved excerpts are UNTRUSTED (OWASP LLM01).
 * They reach the model only through `ClaimExtractor` / `FaithfulnessJudge`,
 * whose prompts frame both as data to be evaluated, never as instructions.
 */
import type { Citation, FindingFaithfulness } from "@metis/shared";
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  TokenUsage,
} from "../ai/types.js";
import { ClaimExtractor } from "../docs-gen/grounding/claim-extractor.js";
import { FaithfulnessJudge } from "../docs-gen/grounding/faithfulness-judge.js";
import type { ScoreFaithfulnessDeps } from "../docs-gen/grounding/citation-validator.js";
import {
  scoreEvidenceFaithfulness,
  type FaithfulnessEvidence,
  type FaithfulnessMetric,
} from "../grounding/faithfulness-metric.js";
import { createChildLogger } from "../logger.js";
import { markServerAuthored } from "./server-authored.js";
import {
  MAX_PANEL_EVIDENCE_ITEMS,
  selectFindingEvidence,
  type PanelEvidence,
} from "./support-panel.js";

const log = createChildLogger("analysis-finding-faithfulness");

/**
 * Feature flag: `ANALYSIS_FAITHFULNESS_METRIC`. **DEFAULT OFF.**
 *
 * Opt-IN, like `ANALYSIS_LLM_SUPPORT_PANEL` and for the same reason: it adds
 * model calls per finding. `pnpm eval:verification --faithfulness` reports the
 * metric per arm so a default flip happens on a measured delta rather than on
 * confidence.
 */
export function analysisFaithfulnessMetricEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ANALYSIS_FAITHFULNESS_METRIC;
  return v === "1" || v === "true";
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const addUsage = (a: TokenUsage, b: TokenUsage | undefined): TokenUsage =>
  b
    ? {
        promptTokens: a.promptTokens + (b.promptTokens ?? 0),
        completionTokens: a.completionTokens + (b.completionTokens ?? 0),
        totalTokens: a.totalTokens + (b.totalTokens ?? 0),
      }
    : a;

/**
 * A pass-through {@link AIProvider} that accumulates the usage of every `chat`
 * it forwards.
 *
 * The shared claim-extraction + judge substrate reports usage on each
 * `ChatResponse`, but `scoreFaithfulness` does not surface it — and a metric
 * whose token cost is invisible cannot be traded against its value, which is the
 * exact failure #1108's cost accounting exists to prevent. Wrapping is preferred
 * to threading a usage out-param through three shared modules docs-gen also
 * calls.
 *
 * Only `chat` is intercepted; every other member delegates unchanged.
 */
export class UsageCountingProvider implements AIProvider {
  usage: TokenUsage = { ...ZERO_USAGE };
  llmCalls = 0;

  constructor(private readonly inner: AIProvider) {}

  get key(): AIProvider["key"] {
    return this.inner.key;
  }
  get model(): string {
    return this.inner.model;
  }
  get offline(): boolean {
    return this.inner.offline;
  }
  get capabilities(): AIProvider["capabilities"] {
    return this.inner.capabilities;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const res = await this.inner.chat(messages, opts);
    this.llmCalls += 1;
    this.usage = addUsage(this.usage, res.usage);
    return res;
  }

  stream(messages: ChatMessage[], opts?: ChatOptions): ReturnType<AIProvider["stream"]> {
    return this.inner.stream(messages, opts);
  }
  embed(texts: string[]): ReturnType<AIProvider["embed"]> {
    return this.inner.embed(texts);
  }
  models(): Promise<string[]> {
    return this.inner.models();
  }
  ping(): Promise<boolean> {
    return this.inner.ping();
  }
}

/**
 * Map the shared metric onto the persisted shape.
 *
 * The result is MARKED as server-authored ({@link markServerAuthored}). This is
 * the single point at which a `faithfulness` value the storage boundary will
 * accept comes into existence: `persistAgentResult` persists only marked
 * values, so a `faithfulness` that arrived from a model — on any of the five
 * `agentFindingPayloadSchema` parse sites, into any of the eight
 * `persistAgentResult(` call sites — is dropped rather than recorded as a
 * measurement nothing measured. Marking here rather than at the call site means
 * a future scoring path cannot forget to opt in.
 *
 * Pure apart from that registration, which is unobservable in the returned
 * value: the mark is a `WeakSet` membership, not a property, so it never
 * serializes into the evidence blob or the API response.
 */
export function toFindingFaithfulness(m: FaithfulnessMetric): FindingFaithfulness {
  return markServerAuthored({
    score: m.faithfulness,
    totalClaims: m.totalClaims,
    supportedClaims: m.supportedClaims,
    ...(m.unverifiableReason ? { unverifiableReason: m.unverifiableReason } : {}),
  });
}

/**
 * Render the panel's evidence shape into the neutral evidence shape. Pure.
 *
 * The locator is the SAME `file:start-end` form the panel renders and the #734
 * gate grounds citations against, so an attribution the judge returns resolves
 * against something a reader can open.
 */
export function toFaithfulnessEvidence(evidence: readonly PanelEvidence[]): FaithfulnessEvidence[] {
  return evidence.map((e) => ({
    id:
      e.startLine != null
        ? `${e.filePath}:${e.startLine}${e.endLine != null ? `-${e.endLine}` : ""}`
        : e.filePath,
    label: e.filePath,
    text: e.excerpt,
  }));
}

export interface FindingFaithfulnessOptions {
  /** Override the flag. Defaults to {@link analysisFaithfulnessMetricEnabled}. */
  enabled?: boolean;
  /** Override the provider default model for the extractor/judge calls. */
  model?: string;
  signal?: AbortSignal;
  /** Cap the excerpts shown per finding. Defaults to the panel's own cap. */
  maxEvidenceItems?: number;
  /** Override the claim extractor (tests / evals). */
  extractor?: ScoreFaithfulnessDeps["extractor"];
  /** Override the NLI judge (tests / evals). */
  judge?: ScoreFaithfulnessDeps["judge"];
}

/**
 * Score ONE finding.
 *
 * Returns `null` — meaning *"the metric did not run"*, which is distinct from an
 * unverifiable `score: null` — when the flag is off or the finding has no
 * evidence to be judged against. Both skip the provider entirely, so a run with
 * nothing to measure costs nothing.
 *
 * Evidence is selected with the panel's own {@link selectFindingEvidence} so the
 * two graders read the SAME excerpts. If they saw different evidence, "the panel
 * says X but faithfulness says Y" would be unresolvable.
 */
export async function scoreFindingFaithfulness(
  provider: AIProvider,
  input: {
    finding: { title: string; body: string };
    citations: readonly Citation[];
    evidencePool: readonly PanelEvidence[];
  },
  opts: FindingFaithfulnessOptions = {},
): Promise<{ faithfulness: FindingFaithfulness; usage: TokenUsage; llmCalls: number } | null> {
  if (!(opts.enabled ?? analysisFaithfulnessMetricEnabled())) return null;
  const evidence = selectFindingEvidence(
    input.citations,
    input.evidencePool,
    opts.maxEvidenceItems ?? MAX_PANEL_EVIDENCE_ITEMS,
  );
  if (evidence.length === 0) return null;

  const counting = new UsageCountingProvider(provider);
  const extractor =
    opts.extractor ??
    new ClaimExtractor({ provider: counting, ...(opts.model ? { model: opts.model } : {}) });
  const judge =
    opts.judge ??
    new FaithfulnessJudge({ provider: counting, ...(opts.model ? { model: opts.model } : {}) });

  // The finding's TITLE and BODY together are the claim-bearing text: a title
  // alone ("Missing rate limit on /login") is the assertion a reader acts on,
  // and a body alone loses it.
  const text = `${input.finding.title}\n\n${input.finding.body}`;
  const metric = await scoreEvidenceFaithfulness(
    input.finding.title.slice(0, 120),
    text,
    toFaithfulnessEvidence(evidence),
    {
      extractor,
      judge,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
  return {
    faithfulness: toFindingFaithfulness(metric),
    usage: counting.usage,
    llmCalls: counting.llmCalls,
  };
}

/**
 * Drop any `faithfulness` the MODEL authored. This field is the server's to
 * write, exactly like `verificationStatus` and `supportPanel`.
 *
 * The structured-output path already makes it unemittable —
 * `structured-output-schemas.ts` omits it and sets `additionalProperties: false`
 * — but that schema is only used where the provider supports strict JSON output.
 * On the plain-Zod path `agentFindingPayloadSchema` accepts the field as nullish.
 *
 * SCOPE. This strip covers only the paths that reach THIS module: flag off and
 * scoring failed, on the two `code` agents that run the graders. It is what
 * keeps the IN-MEMORY `AgentOutput` this module returns honest. It is NOT the
 * enforcement point — `runOneAgent` persists the `document`, `business` and
 * `database` specialists with no grader in between and never calls this. The
 * refusal that covers every path lives at the storage boundary, in
 * `persistAgentResult`, keyed on {@link markServerAuthored}.
 */
function withoutModelAuthoredMetric<T extends FaithfulnessScorableFinding>(f: T): T {
  if (!("faithfulness" in f)) return f;
  const { faithfulness: _modelAuthored, ...rest } = f;
  return rest as T;
}

/** What {@link applyFindingFaithfulness} needs of a finding, and gives back. */
export interface FaithfulnessScorableFinding {
  title: string;
  body: string;
  citations: Citation[];
  faithfulness?: FindingFaithfulness | null;
}

/**
 * Score EVERY finding of one agent pass and return them with the metric
 * attached, plus the token usage to fold into that agent's own accounting.
 *
 * Findings are processed SEQUENTIALLY, mirroring `applySupportPanel`: an
 * analysis run must not become a thundering herd against the provider.
 *
 * COST, stated rather than capped: two model calls per scorable finding (one
 * extraction, one judgement), with no ceiling on the number of findings —
 * exactly the shape and exactly the exposure `applySupportPanel` already has.
 * Both are opt-in and default OFF, so the uncapped fan-out is only reachable by
 * an operator who turned the flag on deliberately. A per-run cap is a
 * PREREQUISITE for flipping either default, not for landing the metric, and it
 * belongs on both graders at once rather than on this one alone.
 *
 * **This function cannot fail a run.** Any error other than cancellation is
 * logged and swallowed, leaving that finding exactly as it arrived — with no
 * `faithfulness` field at all, which is the honest record of "not measured".
 * Cancellation still propagates: an aborted run must stop.
 *
 * **It never writes `verificationStatus`, `verdict` or `supportPanel`.** It
 * spreads the input finding and adds one key.
 *
 * Any `faithfulness` the MODEL authored is DROPPED — see
 * {@link withoutModelAuthoredMetric}.
 */
export async function applyFindingFaithfulness<T extends FaithfulnessScorableFinding>(
  provider: AIProvider,
  findings: readonly T[],
  evidencePool: readonly PanelEvidence[],
  opts: FindingFaithfulnessOptions = {},
): Promise<{ findings: T[]; usage: TokenUsage }> {
  if (!(opts.enabled ?? analysisFaithfulnessMetricEnabled())) {
    return { findings: findings.map(withoutModelAuthoredMetric), usage: ZERO_USAGE };
  }
  const out: T[] = [];
  let usage = ZERO_USAGE;
  for (const f of findings) {
    let scored: Awaited<ReturnType<typeof scoreFindingFaithfulness>> = null;
    try {
      scored = await scoreFindingFaithfulness(
        provider,
        { finding: { title: f.title, body: f.body }, citations: f.citations, evidencePool },
        { ...opts, enabled: true },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (opts.signal?.aborted) throw err;
      log.warn("Faithfulness scoring failed for a finding — leaving it unmeasured", {
        title: f.title.slice(0, 120),
        error: (err as Error).message,
      });
    }
    if (scored) {
      usage = addUsage(usage, scored.usage);
      out.push({ ...f, faithfulness: scored.faithfulness });
    } else {
      // Unmeasured must mean ABSENT, not "whatever the model said".
      out.push(withoutModelAuthoredMetric(f));
    }
  }
  return { findings: out, usage };
}
