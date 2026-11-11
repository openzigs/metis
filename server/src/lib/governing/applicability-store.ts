/**
 * Epic #1866 (#1873) — an analysis's governing-rule applicability, stored.
 *
 * #1872 decides, per requirement, which governing rules apply; #1997 joins that
 * work after synthesis. This module keeps the result on the analysis
 * (`Analysis.metadata.governingApplicability`, the shared
 * `governingAnalysisApplicabilitySchema`) so the BA's business questions can be
 * asked from it in a later request, and a BA answer can move a pair out of
 * `uncertain` where every later reader sees it. Every write is a
 * read-modify-write under the analysis row lock
 * (`updateGoverningApplicabilityMetadata`).
 */
import {
  governingAnalysisApplicabilitySchema,
  type GoverningAnalysisApplicability,
  type GoverningApplicabilityDecision,
  type GoverningApplicabilityVerdict,
  type GoverningRequirementApplicability,
} from "@metis/shared";
import {
  readGoverningApplicabilityMetadata,
  updateGoverningApplicabilityMetadata,
} from "../analysis/analysis-service.js";
import type { RequirementEvidence } from "../analysis/retrieval.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("governing-applicability-store");

/** The stored form of the evidence's applicability sets; requirements without one are left out. */
export function toStoredApplicability(
  evidence: readonly RequirementEvidence[],
  decidedAt: Date = new Date(),
): GoverningAnalysisApplicability {
  return {
    decidedAt: decidedAt.toISOString(),
    requirements: evidence.flatMap((e) =>
      e.governing
        ? [
            {
              requirementId: e.requirementId,
              text: e.text,
              decisions: e.governing.decisions.map((d) => ({
                ruleId: d.ruleId,
                controlId: d.controlId,
                verdict: d.verdict,
                reason: d.reason,
                ...(d.businessFact ? { businessFact: d.businessFact } : {}),
                foundBy: d.foundBy,
              })),
              ...(e.governing.error ? { error: e.governing.error } : {}),
            },
          ]
        : [],
    ),
  };
}

/** Store an analysis's applicability, replacing any earlier one. */
export async function persistGoverningApplicability(
  analysisId: string,
  stored: GoverningAnalysisApplicability,
): Promise<void> {
  await updateGoverningApplicabilityMetadata(analysisId, () => stored);
}

/**
 * The analysis's stored applicability, or `null` when it has none — the flag
 * was off, nothing was decided — or what is stored does not read as one.
 */
export async function readGoverningApplicability(
  analysisId: string,
): Promise<GoverningAnalysisApplicability | null> {
  return parseStoredApplicability(await readGoverningApplicabilityMetadata(analysisId));
}

function parseStoredApplicability(raw: unknown): GoverningAnalysisApplicability | null {
  if (raw === undefined || raw === null) return null;
  const parsed = governingAnalysisApplicabilitySchema.safeParse(raw);
  if (!parsed.success) {
    log.warn("stored governing applicability does not parse; read as none", {
      issues: parsed.error.issues.length,
    });
    return null;
  }
  return parsed.data;
}

/** A BA answer's re-decision of one (requirement, rule) pair. */
export interface GoverningSettlementInput {
  requirementId: string;
  ruleId: string;
  verdict: GoverningApplicabilityVerdict;
  reason: string;
  questionId: string;
  /** #1874 — the question's text, kept so a finding is judged on the question and answer. */
  question?: string;
  answer: string;
}

/** #2068 — the ids of every question whose answer is recorded on `d`. */
export function recordedQuestionIds(d: GoverningApplicabilityDecision): Set<string> {
  const s = d.settled;
  return new Set(s ? [s.questionId, ...(s.earlier ?? []).map((e) => e.questionId)] : []);
}

/**
 * Apply `settlements` to `stored`: each names a pair that is still `uncertain`
 * and has no settlement yet; any other is ignored, so an answer can never
 * overturn a verdict the model reached without asking, nor be applied twice.
 * Returns the pairs it changed.
 *
 * #2059 — or a pair that `applies`, has no settlement yet, and is settled
 * `applies`: a BA answer to a Needs BA input finding on a rule that applies.
 * Its verdict and reason are kept; only the answer is recorded
 * (`previousVerdict: "applies"`), so the findings refresh reads it
 * (`findingPairsOf`). A settlement that would move such a pair elsewhere is
 * ignored, as on any verdict reached without asking.
 *
 * #2068 — a pair that `applies` can be asked again: its finding was still
 * Needs BA input after the answer, with a new question. A later question's
 * answer is then recorded too, the earlier ones kept in `earlier`, oldest
 * first; an answer to a question already recorded on the pair is ignored.
 */
export function applySettlements(
  stored: GoverningAnalysisApplicability,
  settlements: readonly GoverningSettlementInput[],
  at: Date = new Date(),
): { next: GoverningAnalysisApplicability; applied: GoverningSettlementInput[] } {
  const applied: GoverningSettlementInput[] = [];
  const next: GoverningAnalysisApplicability = {
    ...stored,
    requirements: stored.requirements.map((r) => ({
      ...r,
      decisions: r.decisions.map((d): GoverningApplicabilityDecision => {
        const s = settlements.find(
          (x) => x.requirementId === r.requirementId && x.ruleId === d.ruleId,
        );
        if (!s) return d;
        if (d.verdict === "applies" && s.verdict === "applies") {
          if (recordedQuestionIds(d).has(s.questionId)) return d;
          applied.push(s);
          const earlier = d.settled
            ? [
                ...(d.settled.earlier ?? []),
                {
                  questionId: d.settled.questionId,
                  ...(d.settled.question ? { question: d.settled.question } : {}),
                  answer: d.settled.answer,
                  at: d.settled.at,
                },
              ]
            : [];
          return {
            ...d,
            settled: {
              questionId: s.questionId,
              ...(s.question ? { question: s.question } : {}),
              answer: s.answer,
              // The verdict before the pair's first answer.
              previousVerdict: d.settled?.previousVerdict ?? "applies",
              at: at.toISOString(),
              ...(earlier.length > 0 ? { earlier } : {}),
            },
          };
        }
        if (d.settled || d.verdict !== "uncertain") return d;
        applied.push(s);
        const { businessFact: _fact, ...rest } = d;
        return {
          ...rest,
          verdict: s.verdict,
          reason: s.reason,
          ...(s.verdict === "uncertain" && d.businessFact ? { businessFact: d.businessFact } : {}),
          settled: {
            questionId: s.questionId,
            ...(s.question ? { question: s.question } : {}),
            answer: s.answer,
            previousVerdict: "uncertain",
            at: at.toISOString(),
          },
        };
      }),
    })),
  };
  return { next, applied };
}

/**
 * #2222 — store one requirement's applicability (a re-check's), replacing the
 * entry with the same requirement id or adding it, under the row lock. An
 * analysis with none stored gets one holding just this entry.
 */
export async function upsertGoverningRequirementApplicability(
  analysisId: string,
  entry: GoverningRequirementApplicability,
  decidedAt: Date = new Date(),
): Promise<void> {
  await updateGoverningApplicabilityMetadata(analysisId, (raw) => {
    const stored = parseStoredApplicability(raw) ?? {
      decidedAt: decidedAt.toISOString(),
      requirements: [],
    };
    const others = stored.requirements.filter((r) => r.requirementId !== entry.requirementId);
    return { ...stored, requirements: [...others, entry] };
  });
}

/** Write `settlements` onto the analysis's stored applicability, under the row lock. */
export async function settleGoverningPairs(
  analysisId: string,
  settlements: readonly GoverningSettlementInput[],
): Promise<GoverningSettlementInput[]> {
  let applied: GoverningSettlementInput[] = [];
  await updateGoverningApplicabilityMetadata(analysisId, (raw) => {
    const stored = parseStoredApplicability(raw);
    if (!stored) return undefined;
    const out = applySettlements(stored, settlements);
    applied = out.applied;
    return applied.length > 0 ? out.next : undefined;
  });
  return applied;
}
