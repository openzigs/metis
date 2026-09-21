import { describe, expect, it } from "vitest";
import {
  AcceptSuggestionBodySchema,
  CoverageMappingSchema,
  CreateRunBodySchema,
  GapItemSchema,
  GwtSchema,
  ImportStatusSchema,
  MappingStatusSchema,
  NormalisedTestCaseSchema,
  OverrideMappingBodySchema,
  PrioritySchema,
  RunModeSchema,
  RunStatusSchema,
  SuggestionSchema,
  SuggestionStatusSchema,
  TEST_CASE_SOURCES,
  TestCaseDocSchema,
  TestCaseImportSchema,
  TestCaseSourceSchema,
  TestCoverageRunSchema,
  TestStepSchema,
} from "../src/testcoverage.js";

const NOW = new Date("2026-05-27T00:00:00Z").toISOString();

describe("testcoverage enums", () => {
  it("TestCaseSourceSchema accepts every documented source", () => {
    for (const source of TEST_CASE_SOURCES) {
      expect(TestCaseSourceSchema.parse(source)).toBe(source);
    }
  });

  it("rejects an unknown source", () => {
    expect(() => TestCaseSourceSchema.parse("postman")).toThrow();
  });

  it.each([
    ["PrioritySchema", PrioritySchema, "medium", "urgent"],
    ["RunStatusSchema", RunStatusSchema, "completed", "done"],
    ["ImportStatusSchema", ImportStatusSchema, "importing", "loading"],
    ["MappingStatusSchema", MappingStatusSchema, "COVERED", "covered"],
    ["SuggestionStatusSchema", SuggestionStatusSchema, "draft", "pending"],
    ["RunModeSchema", RunModeSchema, "A", "C"],
  ])("%s accepts valid + rejects bad", (_label, schema, ok, bad) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((schema as any).parse(ok)).toBe(ok);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (schema as any).parse(bad)).toThrow();
  });
});

describe("TestStep + NormalisedTestCase", () => {
  it("requires an action string", () => {
    expect(() => TestStepSchema.parse({})).toThrow();
    expect(TestStepSchema.parse({ action: "click" })).toMatchObject({
      action: "click",
    });
  });

  it("defaults steps/tags/priority on a normalised case", () => {
    const parsed = NormalisedTestCaseSchema.parse({
      title: "Login",
      source: "csv",
    });
    expect(parsed.steps).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.priority).toBe("medium");
  });

  it("rejects empty title", () => {
    expect(() => NormalisedTestCaseSchema.parse({ title: "", source: "csv" })).toThrow();
  });
});

describe("TestCaseDoc / TestCaseImport / TestCoverageRun", () => {
  it("TestCaseDocSchema round-trips a minimal record", () => {
    const dto = TestCaseDocSchema.parse({
      id: "c1",
      projectId: "p1",
      sourceImportId: "i1",
      externalId: null,
      title: "Login",
      preconditions: null,
      steps: [{ action: "click" }],
      expected: null,
      priority: "medium",
      tags: ["auth"],
      source: "csv",
      contentHash: "deadbeef",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(dto.tags).toEqual(["auth"]);
  });

  it("TestCaseImportSchema enforces non-negative testCount", () => {
    expect(() =>
      TestCaseImportSchema.parse({
        id: "i",
        projectId: "p",
        runId: null,
        source: "csv",
        status: "completed",
        label: "f.csv",
        testCount: -1,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();
  });

  it("TestCoverageRunSchema validates the phaseProgress map", () => {
    const dto = TestCoverageRunSchema.parse({
      id: "r1",
      projectId: "p1",
      createdById: "u1",
      status: "running",
      mode: "A",
      contentHash: "h",
      tokenCostCents: 0,
      phaseProgress: { import: { pct: 50, ts: NOW } },
      error: null,
      startedAt: NOW,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(dto.phaseProgress.import.pct).toBe(50);
  });
});

describe("CoverageMapping + GapItem + Suggestion", () => {
  it("CoverageMappingSchema enforces enum status", () => {
    expect(() =>
      CoverageMappingSchema.parse({
        id: "m",
        runId: "r",
        requirementId: "rq",
        testCaseDocId: "tc",
        cosine: 0.8,
        bm25: 0.5,
        fused: 0.7,
        judgeConfidence: null,
        status: "MAYBE",
        overriddenById: null,
        overrideReason: null,
      }),
    ).toThrow();
  });

  it("GapItemSchema requires a recognised severity", () => {
    const gap = GapItemSchema.parse({
      id: "g",
      runId: "r",
      requirementId: "rq",
      severity: "high",
      meta: { bestCosine: 0.2 },
    });
    expect(gap.severity).toBe("high");
  });

  it("GwtSchema defaults all arrays to []", () => {
    expect(GwtSchema.parse({})).toEqual({ given: [], when: [], then: [] });
  });

  it("SuggestionSchema clamps faithfulness to [0,1]", () => {
    expect(() =>
      SuggestionSchema.parse({
        id: "s",
        runId: "r",
        mappedRequirementIds: ["rq1"],
        title: "Test login",
        gwt: { given: ["a"], when: ["b"], then: ["c"] },
        steps: [{ action: "click" }],
        faithfulness: 1.5,
        sourceChunks: [],
        status: "draft",
        lowConfidence: false,
      }),
    ).toThrow();
  });
});

describe("request body schemas", () => {
  it("CreateRunBodySchema defaults mode to A", () => {
    expect(CreateRunBodySchema.parse({}).mode).toBe("A");
  });

  it("OverrideMappingBodySchema requires reason", () => {
    expect(() => OverrideMappingBodySchema.parse({ status: "COVERED", reason: "" })).toThrow();
  });

  it("AcceptSuggestionBodySchema allows accepted/rejected only", () => {
    expect(AcceptSuggestionBodySchema.parse({ status: "accepted" }).status).toBe("accepted");
    expect(() => AcceptSuggestionBodySchema.parse({ status: "exported" })).toThrow();
  });
});
