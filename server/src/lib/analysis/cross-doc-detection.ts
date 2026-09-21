/**
 * Cross-document detection pass (Epic #203 / Issue #221 integration).
 *
 * Orchestrates the three detectors over the ingested-doc set and normalises
 * their output into the first-class {@link CrossDocFinding} shape that is
 * persisted (Prisma) and surfaced on the analysis snapshot:
 *
 *   1. {@link CrossDocValidator}     (#218) — Markdown consistency report.
 *      Its `contradictions` bullets are folded in as additional contradiction
 *      findings so the generalized spec-kit logic contributes to the pipeline.
 *   2. {@link ContradictionDetector} (#219) — NLI self + pairwise contradictions.
 *   3. {@link CompletenessChecker}   (#220) — missing NFRs / ACs / assumptions / risks.
 *
 * This is the seam the orchestrator invokes post-synthesis, BEFORE
 * `persistRequirements()`. It performs no persistence itself — the caller
 * persists via `persistCrossDocFindings()` — so it stays unit-testable with a
 * mocked provider and the offline stub.
 */
import { randomUUID } from "node:crypto";
import {
  type CompletenessGap,
  type CrossDocFinding,
  type CrossDocFindingKind,
  type FindingSeverity,
  type NliVerdict,
} from "@metis/shared";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { CompletenessChecker } from "./completeness-checker.js";
import { ContradictionDetector } from "./contradiction-detector.js";
import { CrossDocValidator, type DocSegment } from "./cross-doc-validator.js";

const log = createChildLogger("cross-doc-detection");

export interface RunCrossDocDetectionInput {
  provider: AIProvider;
  segments: DocSegment[];
  model?: string;
  signal?: AbortSignal;
  /** Optional elicited artifacts (#208) forwarded to the completeness checker. */
  elicitedArtifacts?: string;
  /** Override the clock for deterministic tests. */
  now?: () => Date;
}

export interface CrossDocDetectionResult {
  findings: CrossDocFinding[];
  contradictionCount: number;
  completenessGapCount: number;
  generatedAt: string;
  usage: TokenUsage;
}

/** Completeness gap kind → finding severity. Risks/NFRs are weightier gaps. */
const GAP_SEVERITY: Record<CompletenessGap["kind"], FindingSeverity> = {
  "missing-nfr": "medium",
  "missing-acceptance-criteria": "medium",
  "missing-assumption": "low",
  "missing-risk": "medium",
};

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (!add) return;
  into.promptTokens += add.promptTokens;
  into.completionTokens += add.completionTokens;
  into.totalTokens += add.totalTokens;
}

function contradictionToFinding(v: NliVerdict): CrossDocFinding {
  return {
    id: randomUUID(),
    kind: "contradiction",
    // A contradiction across the corpus is material — flag it as high.
    severity: "high",
    title: `Contradiction: "${v.premise.slice(0, 80)}" vs "${v.hypothesis.slice(0, 80)}"`.slice(
      0,
      255,
    ),
    detail: `Premise: ${v.premise}\nHypothesis: ${v.hypothesis}`,
    evidenceIds: v.evidenceIds,
    scope: v.scope,
  };
}

function gapToFinding(g: CompletenessGap): CrossDocFinding {
  return {
    id: randomUUID(),
    kind: g.kind as CrossDocFindingKind,
    severity: GAP_SEVERITY[g.kind],
    title: g.title.slice(0, 255),
    detail: g.rationale,
    evidenceIds: g.evidenceIds,
    scope: null,
  };
}

/**
 * Fold the consistency validator's free-text `contradictions` bullets into the
 * findings list. These complement the NLI verdicts (#219) — the validator
 * reasons holistically over the whole corpus while the NLI detector reasons
 * over statement pairs, so both contribute. Evidence ids are unknown for these
 * free-text bullets, so they carry the full segment id set as evidence.
 */
function consistencyContradictionToFinding(text: string, segmentIds: string[]): CrossDocFinding {
  return {
    id: randomUUID(),
    kind: "contradiction",
    severity: "high",
    title: `Consistency contradiction: ${text.slice(0, 80)}`.slice(0, 255),
    detail: text,
    evidenceIds: segmentIds,
    scope: "pairwise",
  };
}

export async function runCrossDocDetection(
  input: RunCrossDocDetectionInput,
): Promise<CrossDocDetectionResult> {
  const now = input.now ?? (() => new Date());
  const usage = zeroUsage();

  const usable = input.segments.filter((s) => s.content.trim().length > 0);
  if (usable.length === 0) {
    return {
      findings: [],
      contradictionCount: 0,
      completenessGapCount: 0,
      generatedAt: now().toISOString(),
      usage,
    };
  }

  const { provider, model, signal } = input;
  const findings: CrossDocFinding[] = [];

  // 1. Reusable consistency validator (#218) — holistic, whole-corpus pass.
  const validator = new CrossDocValidator({ provider, model });
  const consistency = await validator.validate(usable, { signal });
  addUsage(usage, consistency.usage);
  const segmentIds = usable.map((s) => s.id);
  for (const text of consistency.report.contradictions) {
    findings.push(consistencyContradictionToFinding(text, segmentIds));
  }

  // 2. NLI contradiction detection (#219) — self + pairwise statement pairs.
  // Dedupe on the normalised premise/hypothesis pair: the same conflicting
  // claim can legitimately surface from multiple passes (a doc's self-pass and
  // a pairwise comparison), but we only want one finding per distinct conflict.
  const detector = new ContradictionDetector({ provider, model });
  const contradictionResult = await detector.detect(usable, { signal });
  addUsage(usage, contradictionResult.usage);
  // When the same conflict surfaces from both a self-pass and a pairwise pass,
  // prefer the pairwise verdict — a cross-document conflict is the more
  // actionable framing for a BA than the same text flagged within one doc.
  const byPair = new Map<string, NliVerdict>();
  for (const v of contradictionResult.contradictions) {
    const key = `${v.premise.trim().toLowerCase()}|${v.hypothesis.trim().toLowerCase()}`;
    const existing = byPair.get(key);
    if (!existing || (existing.scope === "self" && v.scope === "pairwise")) {
      byPair.set(key, v);
    }
  }
  for (const v of byPair.values()) {
    findings.push(contradictionToFinding(v));
  }

  // 3. Completeness checklist (#220) — missing NFRs / ACs / assumptions / risks.
  const checker = new CompletenessChecker({ provider, model });
  const completeness = await checker.check(usable, {
    signal,
    elicitedArtifacts: input.elicitedArtifacts,
  });
  addUsage(usage, completeness.usage);
  for (const g of completeness.gaps) {
    findings.push(gapToFinding(g));
  }

  const contradictionCount = findings.filter((f) => f.kind === "contradiction").length;
  const completenessGapCount = findings.length - contradictionCount;

  log.info("Cross-doc detection complete", {
    contradictions: contradictionCount,
    completenessGaps: completenessGapCount,
  });

  return {
    findings,
    contradictionCount,
    completenessGapCount,
    generatedAt: now().toISOString(),
    usage,
  };
}
