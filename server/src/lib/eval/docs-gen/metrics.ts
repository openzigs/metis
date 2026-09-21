import { z } from "zod";
import type { CorrectnessAggregate, CorrectnessEnvelope } from "../answer-correctness/metric.js";

export const DOCS_GEN_BENCHMARK_SCHEMA_VERSION = 1;
export const DOCS_GEN_BENCHMARK_HARNESS_VERSION = "issue-1357-v1";

const unavailableMetricSchema = z.object({
  reported: z.literal(false),
  reason: z.string().trim().min(1),
});

const scalarMetricSchema = z.object({
  reported: z.literal(true),
  value: z.number().finite().nonnegative(),
  unit: z.string().trim().min(1),
  boundary: z.string().trim().min(1),
});

export const scalarMeasurementSchema = z.union([scalarMetricSchema, unavailableMetricSchema]);

export type ScalarMeasurement = z.infer<typeof scalarMeasurementSchema>;

const retrievalLatencySchema = z.union([
  z.object({
    reported: z.literal(true),
    sampleCount: z.number().int().nonnegative(),
    meanMs: z.number().finite().nonnegative(),
    p95Ms: z.number().finite().nonnegative(),
    boundary: z.string().trim().min(1),
  }),
  unavailableMetricSchema,
]);

export type RetrievalLatencyMeasurement = z.infer<typeof retrievalLatencySchema>;

const tokenCostSchema = z.union([
  z.object({
    reported: z.literal(true),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().finite().nonnegative(),
    boundary: z.string().trim().min(1),
  }),
  unavailableMetricSchema,
]);

export type TokenCostMeasurement = z.infer<typeof tokenCostSchema>;

const supportedClaimRateSchema = z.union([
  z.object({
    reported: z.literal(true),
    supportedClaims: z.number().int().nonnegative(),
    totalClaims: z.number().int().positive(),
    rate: z.number().finite().min(0).max(1),
    boundary: z.string().trim().min(1),
  }),
  unavailableMetricSchema,
]);

export type SupportedClaimRateMeasurement = z.infer<typeof supportedClaimRateSchema>;

const correctnessAggregateSchema = z.object({
  meanRecall: z.number().finite().min(0).max(1).nullable(),
  meanPrecision: z.number().finite().min(0).max(1).nullable(),
  meanF1: z.number().finite().min(0).max(1).nullable(),
  meanAnswerClaims: z.number().finite().nonnegative().nullable(),
  meanReferenceClaims: z.number().finite().nonnegative().nullable(),
  scored: z.number().int().nonnegative(),
  unverifiable: z.number().int().nonnegative(),
});

const missedBehaviorSchema = z.union([
  z.object({
    reported: z.literal(true),
    exploratory: z.boolean(),
    corpusId: z.string().trim().min(1),
    missedRate: z.number().finite().min(0).max(1),
    aggregate: correctnessAggregateSchema,
    interpretation: z.string().trim().min(1).optional(),
    licensePending: z.boolean().optional(),
    reasonCode: z.undefined().optional(),
  }),
  z.object({
    reported: z.literal(false),
    exploratory: z.boolean(),
    corpusId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    reasonCode: z.string().trim().min(1).optional(),
    licensePending: z.boolean().optional(),
  }),
]);

export type MissedExpectedBehaviorMeasurement = z.infer<typeof missedBehaviorSchema>;

const typedSymbolEvidenceConfigSchema = z.object({
  enabled: z.boolean(),
  maxSymbols: z.number().int().positive(),
  neighborDepth: z.number().int().nonnegative(),
  maxNeighbors: z.number().int().nonnegative(),
  maxSourceLines: z.number().int().positive(),
  contextBefore: z.number().int().nonnegative(),
  contextAfter: z.number().int().nonnegative(),
});

const typedSymbolEvidenceReportSchema = z.object({
  enabled: z.boolean(),
  sectionsAttempted: z.number().int().nonnegative(),
  sectionsAugmented: z.number().int().nonnegative(),
  symbolsHydrated: z.number().int().nonnegative(),
  neighborSymbolsHydrated: z.number().int().nonnegative(),
  budgetExhausted: z.boolean(),
  fallbackReason: z.string().trim().min(1).optional(),
});

const typedSymbolExperimentDecisionSchema = z.object({
  outcome: z.enum([
    "not-run",
    "keep-disabled",
    "no-benefit",
    "candidate-improved",
    "insufficient-evidence",
  ]),
  exploratory: z.boolean(),
  rationale: z.string().trim().min(1),
});

const typedSymbolExperimentComparisonSchema = z.object({
  baseline: z.object({
    supportedClaimRate: supportedClaimRateSchema,
    missedExpectedBehavior: missedBehaviorSchema,
    coldGenerationMs: scalarMeasurementSchema.optional(),
    warmGenerationMs: scalarMeasurementSchema.optional(),
    tokenCost: tokenCostSchema.optional(),
  }),
  candidate: z.object({
    supportedClaimRate: supportedClaimRateSchema,
    missedExpectedBehavior: missedBehaviorSchema,
    coldGenerationMs: scalarMeasurementSchema.optional(),
    warmGenerationMs: scalarMeasurementSchema.optional(),
    tokenCost: tokenCostSchema.optional(),
  }),
  deltas: z.object({
    supportedClaimRate: z.number().finite().nullable(),
    missedExpectedBehavior: z.number().finite().nullable(),
    coldGenerationMs: z.number().finite().nullable().optional(),
    warmGenerationMs: z.number().finite().nullable().optional(),
    estimatedCostUsd: z.number().finite().nullable().optional(),
  }),
});

const docsGenExperimentSchema = z.object({
  typedSymbolEvidence: z.object({
    enabled: z.boolean(),
    status: z.enum(["disabled", "compared", "safe-fallback"]),
    config: typedSymbolEvidenceConfigSchema,
    report: typedSymbolEvidenceReportSchema.optional(),
    comparison: typedSymbolExperimentComparisonSchema.optional(),
    decision: typedSymbolExperimentDecisionSchema,
  }),
});

const docsGenBenchmarkResultSchema = z.object({
  schemaVersion: z.literal(DOCS_GEN_BENCHMARK_SCHEMA_VERSION),
  harnessVersion: z.string().trim().min(1),
  generatedAt: z.string().datetime(),
  fixture: z.object({
    id: z.string().trim().min(1),
    mode: z.enum(["single-repo", "multi-repo"]),
    repositoryCount: z.number().int().positive(),
    sourceRevisions: z.array(
      z.object({
        repoId: z.string().trim().min(1),
        commit: z.string().trim().min(1),
      }),
    ),
  }),
  effectiveConfig: z.object({
    pipeline: z.enum(["synthesizer", "route-compatible"]),
    cacheState: z.enum(["cold", "warm", "mixed"]),
    aiProvider: z.string().trim().min(1),
    embeddingsProvider: z.string().trim().min(1),
    modelIdentities: z.array(z.string().trim().min(1)).min(1),
    liveModelRun: z.boolean(),
  }),
  references: z.object({
    corpusId: z.string().trim().min(1),
    calibrationSource: z.string().trim().min(1),
    publicationDisposition: z.enum(["local-only", "pending-1308", "public-approved"]),
  }),
  experiment: docsGenExperimentSchema.optional(),
  measurements: z.object({
    coldIngestionMs: scalarMeasurementSchema,
    warmIngestionMs: scalarMeasurementSchema,
    coldGenerationMs: scalarMeasurementSchema,
    warmGenerationMs: scalarMeasurementSchema,
    peakMemoryBytes: scalarMeasurementSchema,
    retrievalLatency: retrievalLatencySchema,
    tokenCost: tokenCostSchema,
    supportedClaimRate: supportedClaimRateSchema,
    missedExpectedBehavior: missedBehaviorSchema,
  }),
});

export type DocsGenBenchmarkResult = z.infer<typeof docsGenBenchmarkResultSchema>;

export interface DocsGenSectionSupportSample {
  supportedClaims: number;
  totalClaims: number;
}

export function unavailableMeasurement(reason: string): ScalarMeasurement {
  return unavailableMetricSchema.parse({ reported: false, reason });
}

export function measuredScalar(value: number, unit: string, boundary: string): ScalarMeasurement {
  return scalarMetricSchema.parse({ reported: true, value, unit, boundary });
}

export function measuredRetrievalLatency(input: {
  samplesMs: readonly number[];
  boundary: string;
}): RetrievalLatencyMeasurement {
  if (input.samplesMs.length === 0) {
    return { reported: false, reason: "no retrieval samples were recorded for this run" };
  }
  const sorted = [...input.samplesMs].sort((a, b) => a - b);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return retrievalLatencySchema.parse({
    reported: true,
    sampleCount: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95Ms: sorted[p95Index] ?? 0,
    boundary: input.boundary,
  });
}

export function measuredTokenCost(input: {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd: number;
  boundary: string;
}): TokenCostMeasurement {
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;
  return tokenCostSchema.parse({
    reported: true,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: input.promptTokens + input.completionTokens + cacheReadTokens + cacheWriteTokens,
    estimatedCostUsd: input.estimatedCostUsd,
    boundary: input.boundary,
  });
}

export function summarizeSupportedClaimRate(
  samples: readonly DocsGenSectionSupportSample[],
  boundary: string,
): SupportedClaimRateMeasurement {
  const totalClaims = samples.reduce((sum, sample) => sum + sample.totalClaims, 0);
  if (totalClaims === 0) {
    return {
      reported: false,
      reason: "no verified section-level claim support scores were recorded for this run",
    };
  }
  const supportedClaims = samples.reduce((sum, sample) => sum + sample.supportedClaims, 0);
  return supportedClaimRateSchema.parse({
    reported: true,
    supportedClaims,
    totalClaims,
    rate: supportedClaims / totalClaims,
    boundary,
  });
}

export function summarizeMissedExpectedBehavior(input: {
  exploratory: boolean;
  envelope: CorrectnessEnvelope;
}): MissedExpectedBehaviorMeasurement {
  const shared = {
    exploratory: input.exploratory,
    corpusId: input.envelope.corpusId,
    ...(input.envelope.licensePending === undefined
      ? {}
      : { licensePending: input.envelope.licensePending }),
  };
  if (!input.envelope.reported || input.envelope.aggregate === undefined) {
    return missedBehaviorSchema.parse({
      reported: false,
      reason: input.envelope.reason ?? "no correctness result was reported",
      ...(input.envelope.reasonCode ? { reasonCode: input.envelope.reasonCode } : {}),
      ...shared,
    });
  }
  return missedBehaviorSchema.parse({
    reported: true,
    missedRate: missedRateFromAggregate(input.envelope.aggregate),
    aggregate: input.envelope.aggregate,
    ...(input.envelope.interpretation ? { interpretation: input.envelope.interpretation } : {}),
    ...shared,
  });
}

export function missedRateFromAggregate(aggregate: CorrectnessAggregate): number {
  return aggregate.meanRecall === null ? 1 : 1 - aggregate.meanRecall;
}

export function validateDocsGenBenchmarkResult(
  result: DocsGenBenchmarkResult,
): DocsGenBenchmarkResult {
  return docsGenBenchmarkResultSchema.parse(result);
}
