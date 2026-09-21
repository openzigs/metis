import { describe, expect, it } from "vitest";
import type { CorrectnessEnvelope } from "../answer-correctness/metric.js";
import {
  DOCS_GEN_BENCHMARK_HARNESS_VERSION,
  DOCS_GEN_BENCHMARK_SCHEMA_VERSION,
  measuredRetrievalLatency,
  measuredScalar,
  measuredTokenCost,
  summarizeMissedExpectedBehavior,
  summarizeSupportedClaimRate,
  unavailableMeasurement,
  validateDocsGenBenchmarkResult,
} from "./metrics.js";

describe("#1357 docs-gen benchmark metrics", () => {
  it("preserves unavailable scalar measurements instead of fabricating zeros", () => {
    expect(unavailableMeasurement("live token accounting was not enabled")).toEqual({
      reported: false,
      reason: "live token accounting was not enabled",
    });
  });

  it("aggregates supported-claim rate from verified section scores", () => {
    expect(
      summarizeSupportedClaimRate(
        [
          { supportedClaims: 9, totalClaims: 10 },
          { supportedClaims: 3, totalClaims: 5 },
        ],
        "section faithfulness validation after synthesis",
      ),
    ).toEqual({
      reported: true,
      supportedClaims: 12,
      totalClaims: 15,
      rate: 0.8,
      boundary: "section faithfulness validation after synthesis",
    });
  });

  it("marks supported-claim rate unavailable when no verified claims were recorded", () => {
    expect(summarizeSupportedClaimRate([], "unused boundary")).toEqual({
      reported: false,
      reason: "no verified section-level claim support scores were recorded for this run",
    });
  });

  it("reuses answer-correctness recall as missed expected behavior rate", () => {
    const envelope: CorrectnessEnvelope = {
      metric: "answer_correctness",
      corpusId: "docsgen-01-single",
      reported: true,
      referenceCount: 2,
      aggregate: {
        meanRecall: 0.75,
        meanPrecision: 0.5,
        meanF1: 0.6,
        meanAnswerClaims: 4,
        meanReferenceClaims: 3,
        scored: 2,
        unverifiable: 0,
      },
      interpretation: "Recall is the correctness headline.",
      licensePending: true,
    };
    expect(summarizeMissedExpectedBehavior({ exploratory: true, envelope })).toEqual({
      reported: true,
      exploratory: true,
      corpusId: "docsgen-01-single",
      missedRate: 0.25,
      aggregate: envelope.aggregate,
      interpretation: "Recall is the correctness headline.",
      licensePending: true,
    });
  });

  it("keeps missed expected behavior unavailable when answer correctness was not reportable", () => {
    const envelope: CorrectnessEnvelope = {
      metric: "answer_correctness",
      corpusId: "docsgen-01-single",
      reported: false,
      referenceCount: 0,
      reason: "no human-authored reference answers for this corpus yet",
      reasonCode: "no-gold-answers",
    };
    expect(summarizeMissedExpectedBehavior({ exploratory: false, envelope })).toEqual({
      reported: false,
      exploratory: false,
      corpusId: "docsgen-01-single",
      reason: "no human-authored reference answers for this corpus yet",
      reasonCode: "no-gold-answers",
    });
  });

  it("validates a benchmark artifact with mixed measured and unavailable fields", () => {
    const result = validateDocsGenBenchmarkResult({
      schemaVersion: DOCS_GEN_BENCHMARK_SCHEMA_VERSION,
      harnessVersion: DOCS_GEN_BENCHMARK_HARNESS_VERSION,
      generatedAt: "2026-08-15T12:00:00.000Z",
      fixture: {
        id: "docsgen-01-single",
        mode: "single-repo",
        repositoryCount: 1,
        sourceRevisions: [{ repoId: "app", commit: "fixture-app@a1b2c3d" }],
      },
      effectiveConfig: {
        pipeline: "synthesizer",
        cacheState: "cold",
        aiProvider: "offline-stub",
        embeddingsProvider: "offline-stub",
        modelIdentities: ["offline-stub"],
        liveModelRun: false,
      },
      references: {
        corpusId: "docsgen-01-single",
        calibrationSource: "eval-results calibration unavailable in offline smoke",
        publicationDisposition: "pending-1308",
      },
      measurements: {
        coldIngestionMs: measuredScalar(12.5, "ms", "fixture ingest including source seeding"),
        warmIngestionMs: unavailableMeasurement("warm cache was not exercised in this run"),
        coldGenerationMs: measuredScalar(88.1, "ms", "cold synthesizeHolisticDocument invocation"),
        warmGenerationMs: measuredScalar(44.2, "ms", "warm synthesizeHolisticDocument invocation"),
        peakMemoryBytes: measuredScalar(2048, "bytes", "process rss delta during harness run"),
        retrievalLatency: measuredRetrievalLatency({
          samplesMs: [4, 9, 12],
          boundary: "per-section grounding retrieval callback",
        }),
        tokenCost: measuredTokenCost({
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0,
          boundary: "persisted token rows written during this benchmark run",
        }),
        supportedClaimRate: summarizeSupportedClaimRate(
          [{ supportedClaims: 5, totalClaims: 6 }],
          "section faithfulness validation after synthesis",
        ),
        missedExpectedBehavior: summarizeMissedExpectedBehavior({
          exploratory: true,
          envelope: {
            metric: "answer_correctness",
            corpusId: "docsgen-01-single",
            reported: true,
            referenceCount: 1,
            aggregate: {
              meanRecall: 1,
              meanPrecision: 0.5,
              meanF1: 2 / 3,
              meanAnswerClaims: 2,
              meanReferenceClaims: 1,
              scored: 1,
              unverifiable: 0,
            },
          },
        }),
      },
    });
    expect(result.measurements.retrievalLatency).toEqual({
      reported: true,
      sampleCount: 3,
      meanMs: 25 / 3,
      p95Ms: 12,
      boundary: "per-section grounding retrieval callback",
    });
    expect(result.measurements.tokenCost).toEqual({
      reported: true,
      promptTokens: 10,
      completionTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      estimatedCostUsd: 0,
      boundary: "persisted token rows written during this benchmark run",
    });
  });
});
