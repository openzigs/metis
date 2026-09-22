/**
 * Epic #856 — Issue #858 — Coverage scoring orchestrator.
 *
 * Single entry point used by the task-runner to drive the matcher → judge
 * → suggestion pipeline for one coverage run, persist results, and emit
 * progress to the UI.
 *
 * Pure of HTTP/Socket layer concerns — the runner injects the emitter.
 */
import { prisma } from "../prisma.js";
import { getEmbedder } from "../rag/embedder.js";
import { createChildLogger } from "../logger.js";

import { caseText } from "./indexer.js";
import { finaliseCase } from "./normaliser.js";
import {
  type MatcherResult,
  type RequirementInput,
  type TestCaseInput,
  matchRequirements,
} from "./coverage-matcher.js";
import { type JudgeModelCaller, type JudgePair, judgeAmbiguous } from "./judge.js";
import {
  type ExistingCaseVector,
  type RequirementForSuggestion,
  generateSuggestions,
} from "./suggestion-generator.js";
import { CoverageCostTracker, estimateEmbeddingTokens } from "./cost-tracker.js";
import type { NormalisedTestCase, TestCaseSource } from "@metis/shared";

const log = createChildLogger("testcoverage/coverage-service");

export type CoverageProgressPhase = "match" | "judge" | "suggest";

export interface CoverageProgressEvent {
  phase: CoverageProgressPhase;
  state: "running" | "done";
  detail?: Record<string, unknown>;
}

export interface CoverageRunReport {
  matcher: {
    requirements: number;
    covered: number;
    uncovered: number;
    ambiguous: number;
    ambiguousRatio: number;
  };
  judge: {
    batches: number;
    modelCalls: number;
    cacheHits: number;
    promotedToCovered: number;
  };
  suggestions: {
    generated: number;
    rejectedDuplicates: number;
    lowConfidence: number;
  };
  cost: {
    limitCents: number;
    usedCents: number;
    remainingCents: number;
    /** Tokens with no known price; `usedCents` is then a lower bound. */
    unpricedTokens: number;
    /** #77 — the embedding share, which does NOT stop the run. */
    unpricedEmbeddingTokens: number;
    /** #43 — the judge/suggestion share, which does. */
    unpricedLlmTokens: number;
  };
  /**
   * True when the per-run token budget was exhausted and at least one LLM phase
   * (judge / suggestion) was hard-stopped (Epic #880 / #883). The runner maps
   * this onto the `budget_exceeded` run status so the UI surfaces it.
   */
  budgetExceeded: boolean;
  coveragePct: number;
}

export interface CoverageServiceDeps {
  db?: typeof prisma;
  caller: JudgeModelCaller;
  emit?: (event: CoverageProgressEvent) => void;
  budgetCents?: number;
}

export interface CoverageServiceInput {
  runId: string;
  projectId: string;
  userId: string;
}

const noopEmit = () => {};

/**
 * Execute Phase-2 work for a single run. The runner handles import/index
 * before calling this, and persists the score/lifecycle afterwards.
 */
export async function runCoverageScoring(
  input: CoverageServiceInput,
  deps: CoverageServiceDeps,
): Promise<CoverageRunReport> {
  const db = deps.db ?? prisma;
  const emit = deps.emit ?? noopEmit;
  const embedder = getEmbedder();

  const cost = new CoverageCostTracker(
    { runId: input.runId, projectId: input.projectId, userId: input.userId },
    { budgetCents: deps.budgetCents, db },
  );

  // --- Load inputs ---------------------------------------------------------
  // Use the latest non-deleted requirements for the project.
  const reqRows = await db.requirement.findMany({
    where: { projectId: input.projectId, deletedAt: null },
    select: { id: true, title: true, body: true, priority: true },
    orderBy: { createdAt: "asc" },
  });
  const caseRows = await db.testCaseDoc.findMany({
    where: { projectId: input.projectId },
    select: {
      id: true,
      title: true,
      preconditions: true,
      stepsJson: true,
      expected: true,
      priority: true,
      tags: true,
      externalId: true,
      source: true,
      contentHash: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (reqRows.length === 0) {
    log.info("no requirements; skipping coverage scoring", { projectId: input.projectId });
    await cost.flush();
    return emptyReport(cost);
  }

  // --- Match phase ---------------------------------------------------------
  emit({ phase: "match", state: "running" });
  const reqTexts = reqRows.map((r) => `${r.title}\n${r.body}`);
  const reqEmb = await embedder.embed(reqTexts);
  // #58 — under the embedder that ran (read AFTER embed: a failed backend may
  // have been swapped for the hash stub) and the model it reports.
  cost.record({
    phase: "embedding",
    embedder: embedder.key,
    modelId: reqEmb.model,
    embeddingTokens: estimateEmbeddingTokens(reqTexts),
  });
  const requirementInputs: RequirementInput[] = reqRows.map((r, i) => ({
    id: r.id,
    text: reqTexts[i],
    embedding: reqEmb.vectors[i],
  }));

  let testCaseInputs: TestCaseInput[] = [];
  let existingVectors: ExistingCaseVector[] = [];
  if (caseRows.length > 0) {
    const caseTexts = caseRows.map((c) => caseText(hydrateCase(c)));
    const caseEmb = await embedder.embed(caseTexts);
    cost.record({
      phase: "embedding",
      embedder: embedder.key,
      modelId: caseEmb.model,
      embeddingTokens: estimateEmbeddingTokens(caseTexts),
    });
    testCaseInputs = caseRows.map((c, i) => ({
      id: c.id,
      text: caseTexts[i],
      embedding: caseEmb.vectors[i],
    }));
    existingVectors = caseRows.map((c, i) => ({
      testCaseDocId: c.id,
      embedding: caseEmb.vectors[i],
    }));
  }

  const matcher: MatcherResult = matchRequirements(requirementInputs, testCaseInputs);
  emit({
    phase: "match",
    state: "done",
    detail: {
      covered: matcher.covered,
      uncovered: matcher.uncovered,
      ambiguous: matcher.ambiguous,
    },
  });

  // --- Judge phase ---------------------------------------------------------
  emit({ phase: "judge", state: "running" });
  const reqById = new Map(reqRows.map((r) => [r.id, r]));
  const caseTextById = new Map<string, string>();
  testCaseInputs.forEach((c) => caseTextById.set(c.id, c.text));

  const ambiguousPairs: JudgePair[] = [];
  for (const v of matcher.verdicts) {
    if (v.status !== "AMBIGUOUS") continue;
    const req = reqById.get(v.requirementId);
    if (!req) continue;
    for (const cell of v.cells) {
      if (cell.status !== "AMBIGUOUS") continue;
      const tcText = caseTextById.get(cell.testCaseDocId);
      if (!tcText) continue;
      ambiguousPairs.push({
        cell,
        requirementText: `${req.title}\n${req.body}`,
        testCaseText: tcText,
      });
    }
  }

  let promotedToCovered = 0;
  let judgeStats = { batches: 0, modelCalls: 0, cacheHits: 0 };
  let budgetExceeded = false;
  if (ambiguousPairs.length > 0 && cost.exceeded()) {
    // Hard-stop: budget already exhausted before the judge phase — skip the
    // LLM calls entirely (Epic #880 / #883).
    budgetExceeded = true;
    log.warn("token budget exceeded before judge phase; skipping LLM judge", {
      runId: input.runId,
      usedCents: cost.usedCents,
      limitCents: cost.limitCents,
    });
  } else if (ambiguousPairs.length > 0) {
    const res = await judgeAmbiguous(ambiguousPairs, {
      caller: deps.caller,
      sessionId: cost.sessionId,
      userId: input.userId,
      projectId: input.projectId,
      cost,
    });
    judgeStats = {
      batches: res.batches,
      modelCalls: res.modelCalls,
      cacheHits: res.cacheHits,
    };
    // The judge records each batch's spend through the cost tracker itself, so
    // we no longer re-record the aggregate here (that would double-count).
    if (res.budgetExceeded) budgetExceeded = true;
    for (const p of res.pairs) {
      if (p.cell.status === "COVERED") promotedToCovered += 1;
    }
  }
  emit({
    phase: "judge",
    state: "done",
    detail: { ...judgeStats, promotedToCovered, budgetExceeded },
  });

  // --- Persist mappings + gaps --------------------------------------------
  await db.coverageMapping.deleteMany({ where: { runId: input.runId } });
  await db.gapItem.deleteMany({ where: { runId: input.runId } });

  const mappingData = matcher.verdicts.flatMap((v) =>
    v.cells.map((cell) => ({
      runId: input.runId,
      requirementId: cell.requirementId,
      testCaseDocId: cell.testCaseDocId,
      cosine: cell.cosine,
      bm25: cell.bm25,
      fused: cell.fused,
      judgeConfidence: cell.judgeConfidence,
      status: cell.status,
    })),
  );
  if (mappingData.length > 0) {
    await db.coverageMapping.createMany({ data: mappingData });
  }

  // Re-aggregate verdict with promoted judge results.
  const reaggregated = matcher.verdicts.map((v) => {
    const hasCovered = v.cells.some((c) => c.status === "COVERED");
    const hasAmbiguous = v.cells.some((c) => c.status === "AMBIGUOUS");
    const status = hasCovered ? "COVERED" : hasAmbiguous ? "AMBIGUOUS" : "UNCOVERED";
    return { ...v, status };
  });

  const uncoveredVerdicts = reaggregated.filter((v) => v.status !== "COVERED");
  const gapData = uncoveredVerdicts.map((v) => {
    const req = reqById.get(v.requirementId);
    return {
      runId: input.runId,
      requirementId: v.requirementId,
      severity: req?.priority ?? "medium",
      meta: JSON.stringify({ status: v.status, cells: v.cells.length }),
    };
  });
  if (gapData.length > 0) {
    await db.gapItem.createMany({ data: gapData });
  }

  // --- Suggestion phase ----------------------------------------------------
  emit({ phase: "suggest", state: "running" });
  const uncoveredReqIds = uncoveredVerdicts.map((v) => v.requirementId);
  let suggestionsGenerated = 0;
  let rejectedDuplicates = 0;
  let lowConfidence = 0;
  if (uncoveredReqIds.length > 0 && cost.exceeded()) {
    // Hard-stop: budget exhausted before the suggestion phase — skip the LLM
    // generation entirely (Epic #880 / #883).
    budgetExceeded = true;
    log.warn("token budget exceeded before suggestion phase; skipping LLM suggestions", {
      runId: input.runId,
      usedCents: cost.usedCents,
      limitCents: cost.limitCents,
    });
  } else if (uncoveredReqIds.length > 0) {
    const uncoveredReqs: RequirementForSuggestion[] = uncoveredReqIds
      .map((id) => {
        const r = reqById.get(id);
        if (!r) return null;
        // Find embedding from the matcher inputs (same order as reqRows).
        const reqIdx = reqRows.findIndex((row) => row.id === id);
        if (reqIdx < 0) return null;
        return {
          id: r.id,
          title: r.title,
          body: r.body,
          priority: normalisePriority(r.priority),
          embedding: reqEmb.vectors[reqIdx],
        } satisfies RequirementForSuggestion;
      })
      .filter((x): x is RequirementForSuggestion => x !== null);

    const sugResult = await generateSuggestions({
      requirements: uncoveredReqs,
      existingCases: existingVectors,
      caller: deps.caller,
      sessionId: cost.sessionId,
      userId: input.userId,
      projectId: input.projectId,
      // #57 — each call is recorded as it happens and the budget is checked
      // before every cluster, so the generator records its own spend here.
      cost,
    });
    if (sugResult.budgetExceeded) budgetExceeded = true;
    rejectedDuplicates = sugResult.rejectedDuplicates;

    await db.suggestion.deleteMany({ where: { runId: input.runId } });
    const sugRows = sugResult.suggestions.map((s) => {
      if (s.lowConfidence) lowConfidence += 1;
      return {
        runId: input.runId,
        mappedRequirementIds: JSON.stringify(s.item.mappedRequirementIds),
        title: s.item.title,
        gwtJson: JSON.stringify({
          given: s.item.bdd.given,
          when: s.item.bdd.when,
          then: s.item.bdd.then,
          bdd: { feature: s.item.bdd.feature, scenario: s.item.bdd.scenario },
          priority: s.item.priority,
          preconditions: s.item.preconditions,
          tags: s.item.tags,
          confidence: s.item.confidence,
        }),
        stepsJson: JSON.stringify(s.item.steps),
        faithfulness: s.faithfulness,
        sourceChunks: JSON.stringify(s.item.sourceChunks),
        status: "draft",
        lowConfidence: s.lowConfidence,
      };
    });
    if (sugRows.length > 0) {
      await db.suggestion.createMany({ data: sugRows });
      suggestionsGenerated = sugRows.length;
    }
  }
  emit({
    phase: "suggest",
    state: "done",
    detail: { suggestionsGenerated, rejectedDuplicates, lowConfidence, budgetExceeded },
  });

  await cost.flush();

  const coveredCount = reaggregated.filter((v) => v.status === "COVERED").length;
  const coveragePct = reqRows.length === 0 ? 0 : (coveredCount / reqRows.length) * 100;
  const view = cost.view();
  return {
    matcher: {
      requirements: matcher.verdicts.length,
      covered: matcher.covered.length,
      uncovered: matcher.uncovered.length,
      ambiguous: matcher.ambiguous.length,
      ambiguousRatio: matcher.ambiguousRatio,
    },
    judge: { ...judgeStats, promotedToCovered },
    suggestions: {
      generated: suggestionsGenerated,
      rejectedDuplicates,
      lowConfidence,
    },
    cost: {
      limitCents: view.limitCents,
      usedCents: view.usedCents,
      remainingCents: view.remainingCents,
      unpricedTokens: view.unpricedTokens,
      unpricedEmbeddingTokens: view.unpricedEmbeddingTokens,
      unpricedLlmTokens: view.unpricedLlmTokens,
    },
    budgetExceeded,
    coveragePct,
  };
}

function emptyReport(cost: CoverageCostTracker): CoverageRunReport {
  const v = cost.view();
  return {
    matcher: { requirements: 0, covered: 0, uncovered: 0, ambiguous: 0, ambiguousRatio: 0 },
    judge: { batches: 0, modelCalls: 0, cacheHits: 0, promotedToCovered: 0 },
    suggestions: { generated: 0, rejectedDuplicates: 0, lowConfidence: 0 },
    cost: {
      limitCents: v.limitCents,
      usedCents: v.usedCents,
      remainingCents: v.remainingCents,
      unpricedTokens: v.unpricedTokens,
      unpricedEmbeddingTokens: v.unpricedEmbeddingTokens,
      unpricedLlmTokens: v.unpricedLlmTokens,
    },
    budgetExceeded: false,
    coveragePct: 0,
  };
}

function normalisePriority(raw: string): RequirementForSuggestion["priority"] {
  const lc = raw?.toLowerCase();
  if (lc === "low" || lc === "high" || lc === "critical" || lc === "medium") return lc;
  return "medium";
}

function hydrateCase(row: {
  title: string;
  preconditions: string | null;
  stepsJson: string;
  expected: string | null;
  priority: string;
  tags: string;
  externalId: string | null;
  source: string;
}): NormalisedTestCase {
  const finalised = finaliseCase(
    {
      title: row.title,
      preconditions: row.preconditions ?? undefined,
      steps: parseSteps(row.stepsJson),
      expected: row.expected ?? undefined,
      priority: row.priority as NormalisedTestCase["priority"],
      tags: parseTags(row.tags),
      externalId: row.externalId ?? undefined,
    },
    row.source as TestCaseSource,
  );
  if (!finalised) throw new Error(`Persisted case re-validation failed: ${row.title}`);
  return finalised;
}

function parseSteps(raw: string): { action: string; expected?: string }[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (s): s is { action: string; expected?: string } =>
        s && typeof s === "object" && typeof (s as { action?: unknown }).action === "string",
    );
  } catch {
    return [];
  }
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
