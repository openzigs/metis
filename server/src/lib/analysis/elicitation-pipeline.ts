/**
 * Elicitation pipeline — Epic #208 (E6.4 / #233).
 *
 * Ties the NFR/AC elicitor (#231) and the assumptions/risks elicitor (#232)
 * together over an analysis corpus, then formats the elicited artifacts into
 * the single `elicitedArtifacts` string that the existing completeness checklist
 * (Child Epic #203 — `CompletenessChecker` / `runCrossDocDetection`) already
 * accepts. This is an INTEGRATION layer: it does NOT duplicate the completeness
 * infrastructure, it feeds it.
 *
 * Both elicitors run over the joined corpus text in a single pass each (two
 * provider calls total), reusing the in-stack JSON-in-prompt + Zod-post-parse
 * pattern. The pipeline is best-effort by construction at the call site — a
 * failure degrades to "no elicited artifacts" so completeness still runs.
 */
import type { AcceptanceCriterion, Assumption, Nfr, Risk } from "@metis/shared";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { AssumptionRiskElicitor } from "./assumption-risk-elicitor.js";
import type { DocSegment } from "./cross-doc-validator.js";
import { NfrElicitor } from "./nfr-elicitor.js";

const log = createChildLogger("elicitation-pipeline");

export interface ElicitationPipelineInput {
  provider: AIProvider;
  segments: DocSegment[];
  model?: string;
  signal?: AbortSignal;
  /** Per-segment content cap (characters) to bound the prompt. */
  segmentCharCap?: number;
}

export interface ElicitationArtifacts {
  nfrs: Nfr[];
  acceptanceCriteria: AcceptanceCriterion[];
  assumptions: Assumption[];
  risks: Risk[];
}

export interface ElicitationResult extends ElicitationArtifacts {
  usage: TokenUsage;
}

/** Default per-segment truncation — matches the completeness checker. */
export const DEFAULT_ELICITATION_SEGMENT_CAP = 4000;

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (!add) return;
  into.promptTokens += add.promptTokens;
  into.completionTokens += add.completionTokens;
  into.totalTokens += add.totalTokens;
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n…[truncated]` : text;
}

/** Join usable segments into a single corpus string for elicitation. */
export function joinCorpus(segments: DocSegment[], cap: number): string {
  return segments
    .filter((s) => s.content.trim().length > 0)
    .map((s) => `### ${s.label} (id=${s.id})\n${truncate(s.content, cap)}`)
    .join("\n\n");
}

/**
 * Render elicited artifacts into the human-readable block consumed by the
 * completeness checklist via `CompletenessCheckOptions.elicitedArtifacts`.
 * Returns an empty string when nothing was elicited (the checker treats that
 * as "no additional context"). Pure + exported for unit testing.
 */
export function formatElicitedArtifacts(artifacts: ElicitationArtifacts): string {
  const sections: string[] = [];

  if (artifacts.nfrs.length > 0) {
    sections.push(
      "Non-functional requirements:",
      ...artifacts.nfrs.map((n) => {
        const metric = n.metric ? ` [${n.metric}]` : "";
        return `- (${n.category}/${n.priority}) ${n.title}: ${n.description}${metric}`;
      }),
    );
  }

  if (artifacts.acceptanceCriteria.length > 0) {
    sections.push(
      "Acceptance criteria:",
      ...artifacts.acceptanceCriteria.map((a) => {
        const gwt =
          a.given || a.when || a.then ? ` (Given ${a.given}; When ${a.when}; Then ${a.then})` : "";
        return `- ${a.statement}${gwt}`;
      }),
    );
  }

  if (artifacts.assumptions.length > 0) {
    sections.push(
      "Assumptions:",
      ...artifacts.assumptions.map((a) => `- (impact-if-false: ${a.impactIfFalse}) ${a.statement}`),
    );
  }

  if (artifacts.risks.length > 0) {
    sections.push(
      "Risks:",
      ...artifacts.risks.map(
        (r) => `- (likelihood: ${r.likelihood}, impact: ${r.impact}) ${r.title}: ${r.description}`,
      ),
    );
  }

  return sections.join("\n");
}

/** True when the result carries no artifacts at all. */
export function isEmptyElicitation(artifacts: ElicitationArtifacts): boolean {
  return (
    artifacts.nfrs.length === 0 &&
    artifacts.acceptanceCriteria.length === 0 &&
    artifacts.assumptions.length === 0 &&
    artifacts.risks.length === 0
  );
}

/**
 * Run both elicitors over the corpus and return the combined artifacts plus
 * accumulated token usage. Returns an empty result (no provider call) when the
 * corpus is blank.
 */
export async function runElicitation(input: ElicitationPipelineInput): Promise<ElicitationResult> {
  const cap = input.segmentCharCap ?? DEFAULT_ELICITATION_SEGMENT_CAP;
  const corpus = joinCorpus(input.segments, cap);
  const usage = zeroUsage();

  if (!corpus.trim()) {
    return { nfrs: [], acceptanceCriteria: [], assumptions: [], risks: [], usage };
  }

  const nfrElicitor = new NfrElicitor({ provider: input.provider, model: input.model });
  const arElicitor = new AssumptionRiskElicitor({
    provider: input.provider,
    model: input.model,
  });

  // The two elicitors are independent (same corpus in, disjoint artifacts out),
  // so run them concurrently to halve wall-clock latency. Usage is summed after
  // both settle, keeping the accumulated total deterministic regardless of order.
  const [nfrResult, arResult] = await Promise.all([
    nfrElicitor.elicit(corpus, input.signal),
    arElicitor.elicit(corpus, input.signal),
  ]);
  addUsage(usage, nfrResult.usage);
  addUsage(usage, arResult.usage);

  log.info(
    "Elicited %d NFR(s), %d AC(s), %d assumption(s), %d risk(s)",
    nfrResult.nfrs.length,
    nfrResult.acceptanceCriteria.length,
    arResult.assumptions.length,
    arResult.risks.length,
  );

  return {
    nfrs: nfrResult.nfrs,
    acceptanceCriteria: nfrResult.acceptanceCriteria,
    assumptions: arResult.assumptions,
    risks: arResult.risks,
    usage,
  };
}
