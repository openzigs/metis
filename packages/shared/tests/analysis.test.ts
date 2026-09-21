import { describe, expect, it } from "vitest";
import {
  agentResultSchema,
  analysisSchema,
  createAgentResultSchema,
  createAnalysisSchema,
  createFindingSchema,
  createRequirementSchema,
  findingSchema,
  requirementSchema,
  startAnalysisSchema,
} from "../src/analysis.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

describe("analysis domain", () => {
  describe("analysis", () => {
    it("createAnalysisSchema accepts a minimal payload", () => {
      expect(createAnalysisSchema.parse({ projectId: validId })).toMatchObject({
        projectId: validId,
      });
    });

    it("rejects missing projectId", () => {
      expect(() => createAnalysisSchema.parse({})).toThrow();
    });

    it("analysisSchema validates a hydrated row", () => {
      expect(
        analysisSchema.parse({
          id: validId,
          projectId: validId,
          status: "running",
          startedById: validId,
          startedAt: now,
          completedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "running" });
    });

    it("rejects invalid status", () => {
      expect(() =>
        analysisSchema.parse({
          id: validId,
          projectId: validId,
          status: "exploded",
          startedById: validId,
          startedAt: now,
          completedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });
  });

  describe("agentResult", () => {
    it("creates with required fields", () => {
      expect(
        createAgentResultSchema.parse({ analysisId: validId, agentKey: "codebase-assessor" }),
      ).toMatchObject({ agentKey: "codebase-assessor" });
    });

    it("rejects empty agentKey", () => {
      expect(() => createAgentResultSchema.parse({ analysisId: validId, agentKey: "" })).toThrow();
    });

    it("agentResultSchema accepts pending status", () => {
      expect(
        agentResultSchema.parse({
          id: validId,
          analysisId: validId,
          agentKey: "codebase-assessor",
          status: "pending",
          startedAt: now,
          completedAt: null,
          output: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "pending" });
    });
  });

  describe("finding", () => {
    it("happy path", () => {
      expect(
        createFindingSchema.parse({
          agentResultId: validId,
          category: "security",
          severity: "high",
          title: "SQL injection",
          body: "Found in user input handler.",
          derivation: "inferred",
          confidence: 0.7,
        }),
      ).toMatchObject({ severity: "high" });
    });

    it("rejects unknown severity", () => {
      expect(() =>
        createFindingSchema.parse({
          agentResultId: validId,
          category: "security",
          // @ts-expect-error — runtime check
          severity: "doomsday",
          title: "x",
          body: "y",
        }),
      ).toThrow();
    });

    it("rejects empty body", () => {
      expect(() =>
        createFindingSchema.parse({
          agentResultId: validId,
          category: "security",
          severity: "low",
          title: "x",
          body: "",
        }),
      ).toThrow();
    });

    // Issue #1325 — the provenance refinement had NO coverage: deleting the
    // `.refine` from `createFindingSchema` left the whole suite green, which
    // made the rule's only executable statement freely deletable. The schema is
    // type-only (ADR 0010) and the write paths are policed by
    // `server/tests/finding-provenance-ratchet.test.ts`; these keep the
    // documented rule honest wherever a reader reaches for the schema.
    describe("provenance refinement: extracted ⇒ confidence 1.0", () => {
      const base = {
        agentResultId: validId,
        category: "security" as const,
        severity: "high" as const,
        title: "x",
        body: "y",
      };

      it("accepts extracted at confidence 1.0", () => {
        expect(
          createFindingSchema.parse({ ...base, derivation: "extracted", confidence: 1.0 }),
        ).toMatchObject({ derivation: "extracted", confidence: 1 });
      });

      it("rejects extracted below 1.0", () => {
        expect(() =>
          createFindingSchema.parse({ ...base, derivation: "extracted", confidence: 0.99 }),
        ).toThrow(/MUST have confidence===1\.0/);
      });

      it("rejects extracted at 0", () => {
        expect(() =>
          createFindingSchema.parse({ ...base, derivation: "extracted", confidence: 0 }),
        ).toThrow(/MUST have confidence===1\.0/);
      });

      it("reports the failure against the confidence path", () => {
        const result = createFindingSchema.safeParse({
          ...base,
          derivation: "extracted",
          confidence: 0.5,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.path).toEqual(["confidence"]);
        }
      });

      it("leaves inferred and ambiguous free to carry any confidence", () => {
        for (const derivation of ["inferred", "ambiguous"] as const) {
          expect(
            createFindingSchema.parse({ ...base, derivation, confidence: 0.42 }),
          ).toMatchObject({ derivation, confidence: 0.42 });
        }
      });
    });

    it("findingSchema validates a hydrated row", () => {
      expect(
        findingSchema.parse({
          id: validId,
          agentResultId: validId,
          category: "security",
          severity: "info",
          title: "ok",
          body: "ok",
          evidence: null,
          derivation: "inferred",
          confidence: 0.7,
          createdAt: now,
        }),
      ).toMatchObject({ category: "security" });
    });
  });

  describe("requirement", () => {
    it("createRequirementSchema applies defaults", () => {
      const parsed = createRequirementSchema.parse({
        projectId: validId,
        analysisId: validId,
        title: "Add login",
        body: "Implement OAuth login.",
      });
      expect(parsed.type).toBe("feature");
      expect(parsed.priority).toBe("medium");
      expect(parsed.labels).toEqual([]);
    });

    it("rejects too many labels", () => {
      expect(() =>
        createRequirementSchema.parse({
          projectId: validId,
          analysisId: validId,
          title: "x",
          body: "y",
          labels: Array.from({ length: 33 }, (_, i) => `l${i}`),
        }),
      ).toThrow();
    });

    it("requirementSchema validates a hydrated row", () => {
      expect(
        requirementSchema.parse({
          id: validId,
          projectId: validId,
          analysisId: validId,
          type: "feature",
          title: "x",
          body: "y",
          priority: "high",
          labels: "[]",
          storyPoints: 5,
          parentId: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ priority: "high" });
    });
  });

  describe("startAnalysisSchema", () => {
    it("accepts an empty payload (all fields optional)", () => {
      expect(startAnalysisSchema.parse({})).toEqual({});
    });

    it("accepts extraInstructions within bounds", () => {
      expect(
        startAnalysisSchema.parse({ extraInstructions: "Add SSO support for enterprise tenants" }),
      ).toMatchObject({ extraInstructions: "Add SSO support for enterprise tenants" });
    });

    it("accepts extraInstructions at the 4096-char upper bound", () => {
      const max = "a".repeat(4096);
      expect(startAnalysisSchema.parse({ extraInstructions: max })).toMatchObject({
        extraInstructions: max,
      });
    });

    it("rejects extraInstructions over 4096 chars", () => {
      expect(() => startAnalysisSchema.parse({ extraInstructions: "a".repeat(4097) })).toThrow();
    });

    it("rejects an empty extraInstructions string (min 1)", () => {
      expect(() => startAnalysisSchema.parse({ extraInstructions: "" })).toThrow();
    });

    it("omits extraInstructions when not provided", () => {
      const parsed = startAnalysisSchema.parse({ documentIds: [validId] });
      expect(parsed.extraInstructions).toBeUndefined();
    });

    it("accepts the enhancement opt-in flags (Epic #922)", () => {
      const parsed = startAnalysisSchema.parse({
        enableWebResearch: true,
        enableClarification: true,
      });
      expect(parsed.enableWebResearch).toBe(true);
      expect(parsed.enableClarification).toBe(true);
    });

    it("leaves enhancement flags undefined by default (opt-in, off)", () => {
      const parsed = startAnalysisSchema.parse({});
      expect(parsed.enableWebResearch).toBeUndefined();
      expect(parsed.enableClarification).toBeUndefined();
    });

    it("rejects non-boolean enhancement flags", () => {
      expect(() =>
        startAnalysisSchema.parse({ enableWebResearch: "yes" as unknown as boolean }),
      ).toThrow();
    });
  });
});
