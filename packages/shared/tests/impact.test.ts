import { describe, expect, it } from "vitest";
import {
  createImpactAnalysisSchema,
  IMPACT_AFFECTED_RELATIONS,
  IMPACT_ANALYSIS_STATUSES,
  impactAffectedSymbolSchema,
  impactAnalysisSchema,
  impactItemSchema,
  REQUIREMENT_CODE_MAPPING_SOURCES,
  requirementCodeMappingSchema,
} from "../src/impact.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

describe("impact domain", () => {
  describe("constants", () => {
    it("exposes the lifecycle statuses", () => {
      expect(IMPACT_ANALYSIS_STATUSES).toEqual(["pending", "running", "completed", "failed"]);
    });
    it("exposes affected-symbol relations", () => {
      expect(IMPACT_AFFECTED_RELATIONS).toEqual(["direct", "caller", "importer", "dependency"]);
    });
    it("exposes mapping sources", () => {
      expect(REQUIREMENT_CODE_MAPPING_SOURCES).toEqual(["semantic", "manual"]);
    });
  });

  describe("createImpactAnalysisSchema", () => {
    it("accepts a multi-project run sourced from text", () => {
      const parsed = createImpactAnalysisSchema.parse({
        text: "The WMS shall expose a new export endpoint.",
        projectIds: [validId, "clyyyyyyyy0000abcd1234efgh"],
      });
      expect(parsed.projectIds).toHaveLength(2);
    });

    it("defaults includeDependencies to false (downstream deps are opt-in)", () => {
      const parsed = createImpactAnalysisSchema.parse({
        text: "Change something.",
        projectIds: [validId],
      });
      expect(parsed.includeDependencies).toBe(false);
    });

    it("parses an explicit includeDependencies=true", () => {
      const parsed = createImpactAnalysisSchema.parse({
        text: "Change something.",
        projectIds: [validId],
        includeDependencies: true,
      });
      expect(parsed.includeDependencies).toBe(true);
    });

    it("accepts a run sourced from a document", () => {
      expect(() =>
        createImpactAnalysisSchema.parse({ documentId: validId, projectIds: [validId] }),
      ).not.toThrow();
    });

    it("rejects when neither documentId nor text is supplied", () => {
      expect(() => createImpactAnalysisSchema.parse({ projectIds: [validId] })).toThrow();
    });

    it("rejects an empty projectIds array", () => {
      expect(() => createImpactAnalysisSchema.parse({ text: "x", projectIds: [] })).toThrow();
    });
  });

  describe("row schemas", () => {
    it("requirementCodeMappingSchema validates a hydrated row", () => {
      expect(() =>
        requirementCodeMappingSchema.parse({
          id: validId,
          requirementId: validId,
          projectId: validId,
          codeSymbolId: null,
          filePath: "src/foo.ts",
          startLine: 1,
          endLine: 10,
          confidence: 0.8,
          source: "semantic",
          createdAt: now,
        }),
      ).not.toThrow();
    });

    it("impactAnalysisSchema validates a hydrated row", () => {
      expect(() =>
        impactAnalysisSchema.parse({
          id: validId,
          status: "completed",
          documentId: null,
          sourceText: "change text",
          summary: null,
          startedById: validId,
          startedAt: now,
          completedAt: now,
          errorMessage: null,
          totalImpactedSymbols: 3,
          createdAt: now,
          updatedAt: now,
        }),
      ).not.toThrow();
    });

    it("impactItemSchema validates a hydrated row", () => {
      expect(() =>
        impactItemSchema.parse({
          id: validId,
          impactAnalysisId: validId,
          projectId: validId,
          requirementId: validId,
          changeType: "modified",
          severity: "high",
          impactScore: 0.6,
          confidence: 0.7,
          affectedFileCount: 2,
          affectedSymbolCount: 5,
          summary: null,
          createdAt: now,
        }),
      ).not.toThrow();
    });

    it("impactItemSchema rejects an out-of-range impactScore", () => {
      expect(() =>
        impactItemSchema.parse({
          id: validId,
          impactAnalysisId: validId,
          projectId: validId,
          requirementId: null,
          changeType: "removed",
          severity: "low",
          impactScore: 1.5,
          confidence: 0.1,
          affectedFileCount: 0,
          affectedSymbolCount: 0,
          createdAt: now,
        }),
      ).toThrow();
    });

    it("impactAffectedSymbolSchema validates a hydrated row", () => {
      expect(() =>
        impactAffectedSymbolSchema.parse({
          id: validId,
          impactItemId: validId,
          codeSymbolId: validId,
          filePath: "src/foo.ts",
          qualifiedName: "Foo.bar",
          startLine: 5,
          endLine: 9,
          relation: "caller",
          depth: 1,
          confidence: 0.5,
        }),
      ).not.toThrow();
    });
  });
});
