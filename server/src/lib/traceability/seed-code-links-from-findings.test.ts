/**
 * Tests for the analysis-grounding requirement→code seeder
 * (branch feat/req-code-traceability).
 *
 * The seeding logic is exercised with an in-memory fake Prisma (matching the
 * DI pattern of backfill-spec-links / traceability-spine tests) so no DB is
 * needed. Covers: creates a link from a citation filename, creates none when a
 * finding has no citation/filename, dedupes within a run and against existing
 * rows, never invents a path, and the conservative source/confidence values.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_GROUNDING_SOURCE,
  DEFAULT_SEED_CONFIDENCE,
  parseCitationFilenames,
  parseEvidenceFindingIds,
  seedRequirementCodeLinksFromFindings,
  type SeedDeps,
} from "./seed-code-links-from-findings.js";

interface ReqRow {
  id: string;
  projectId: string;
  labels: string | null;
}
interface FindingRow {
  id: string;
  evidence: string | null;
  confidence: number | null;
  /**
   * Project the finding belongs to via agentResult → analysis → projectId.
   * Optional: when omitted the fake treats the finding as belonging to whatever
   * project the query scopes to (so project-agnostic tests need not set it).
   */
  projectId?: string;
}
interface MappingRow {
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: string;
}

/** Build an in-memory fake Prisma with the three models the seeder touches. */
function makeFakePrisma(opts: {
  requirements: ReqRow[];
  findings: FindingRow[];
  mappings?: MappingRow[];
}): { prisma: SeedDeps["prisma"]; created: MappingRow[]; all: MappingRow[] } {
  const mappings: MappingRow[] = [...(opts.mappings ?? [])];
  const created: MappingRow[] = [];

  const prisma = {
    requirement: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) =>
        opts.requirements.find((r) => r.id === where.id && r.projectId === where.projectId) ?? null,
    },
    finding: {
      findMany: async ({
        where,
      }: {
        where: { id: { in: string[] }; agentResult?: { analysis?: { projectId?: string } } };
      }) => {
        // Honor the agentResult → analysis → projectId relation filter the
        // seeder now applies (defense-in-depth project scoping). A finding with
        // no projectId set is treated as matching any scoped project.
        const scopedProjectId = where.agentResult?.analysis?.projectId;
        return opts.findings.filter(
          (f) =>
            where.id.in.includes(f.id) &&
            (scopedProjectId === undefined ||
              f.projectId === undefined ||
              f.projectId === scopedProjectId),
        );
      },
    },
    requirementCodeMapping: {
      findMany: async ({ where }: { where: { requirementId: string; projectId: string } }) =>
        mappings.filter(
          (m) => m.requirementId === where.requirementId && m.projectId === where.projectId,
        ),
      create: async ({ data }: { data: MappingRow }) => {
        mappings.push(data);
        created.push(data);
        return data;
      },
    },
  } as unknown as SeedDeps["prisma"];

  return { prisma, created, all: mappings };
}

function labels(findingIds: string[], extra: string[] = []): string {
  return JSON.stringify([...extra, ...findingIds.map((id) => `finding:${id}`)]);
}

function evidence(filenames: (string | undefined)[]): string {
  return JSON.stringify({
    citations: filenames.map((filename, i) => ({
      documentId: `doc-${i}`,
      chunkIndex: i,
      ...(filename === undefined ? {} : { filename }),
    })),
    tags: [],
    requirementId: null,
  });
}

describe("parseEvidenceFindingIds", () => {
  it("extracts finding:<id> entries and dedupes", () => {
    expect(parseEvidenceFindingIds(labels(["a", "b", "a"], ["security"]))).toEqual(["a", "b"]);
  });
  it("returns [] for null / malformed / non-array / empty id", () => {
    expect(parseEvidenceFindingIds(null)).toEqual([]);
    expect(parseEvidenceFindingIds("{not json")).toEqual([]);
    expect(parseEvidenceFindingIds(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseEvidenceFindingIds(JSON.stringify(["finding:"]))).toEqual([]);
  });
});

describe("parseCitationFilenames", () => {
  it("returns trimmed non-empty filenames only", () => {
    expect(parseCitationFilenames(evidence(["src/a.ts", undefined, "  src/b.ts  "]))).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
  it("returns [] for null / malformed / no citations", () => {
    expect(parseCitationFilenames(null)).toEqual([]);
    expect(parseCitationFilenames("nope")).toEqual([]);
    expect(parseCitationFilenames(JSON.stringify({ citations: "x" }))).toEqual([]);
    expect(parseCitationFilenames(JSON.stringify({}))).toEqual([]);
    expect(parseCitationFilenames(JSON.stringify({ citations: [{ filename: "  " }] }))).toEqual([]);
  });
});

describe("seedRequirementCodeLinksFromFindings", () => {
  const projectId = "proj-1";

  it("creates a RequirementCodeMapping from a finding whose citation has a filename", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [{ id: "f1", evidence: evidence(["src/auth.ts"]), confidence: 0.9 }],
    });
    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(summary).toEqual({ requirementsSeeded: 1, linksCreated: 1, linksSkipped: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      requirementId: "req-1",
      projectId,
      codeSymbolId: null,
      filePath: "src/auth.ts",
      startLine: null,
      endLine: null,
      confidence: 0.9,
      source: ANALYSIS_GROUNDING_SOURCE,
    });
  });

  it("uses the conservative default confidence when the finding has none", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [{ id: "f1", evidence: evidence(["src/x.ts"]), confidence: null }],
    });
    await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(created[0]!.confidence).toBe(DEFAULT_SEED_CONFIDENCE);
  });

  it("clamps out-of-range finding confidence into [0, 1]", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [
        { id: "req-hi", projectId, labels: labels(["f-hi"]) },
        { id: "req-lo", projectId, labels: labels(["f-lo"]) },
      ],
      findings: [
        { id: "f-hi", evidence: evidence(["src/hi.ts"]), confidence: 1.7 },
        { id: "f-lo", evidence: evidence(["src/lo.ts"]), confidence: -0.2 },
      ],
    });
    await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-hi", "req-lo"] },
      { prisma },
    );
    expect(created.find((c) => c.filePath === "src/hi.ts")!.confidence).toBe(1);
    expect(created.find((c) => c.filePath === "src/lo.ts")!.confidence).toBe(0);
  });

  it("ignores a finding whose project does not match the analysis project (query scoping)", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [
        {
          id: "f1",
          evidence: evidence(["src/a.ts"]),
          confidence: 0.6,
          projectId: "other-project",
        },
      ],
    });
    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(created).toHaveLength(0);
    expect(summary).toEqual({ requirementsSeeded: 0, linksCreated: 0, linksSkipped: 0 });
  });

  it("creates none when the finding has no citations / no filename", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [
        { id: "req-1", projectId, labels: labels(["f1"]) },
        { id: "req-2", projectId, labels: labels(["f2"]) },
      ],
      findings: [
        { id: "f1", evidence: evidence([]), confidence: 0.8 }, // no citations
        { id: "f2", evidence: evidence([undefined]), confidence: 0.8 }, // citation, no filename
      ],
    });
    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1", "req-2"] },
      { prisma },
    );
    expect(created).toHaveLength(0);
    expect(summary).toEqual({ requirementsSeeded: 0, linksCreated: 0, linksSkipped: 0 });
  });

  it("creates nothing for a requirement with no evidence findings", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: JSON.stringify(["security"]) }],
      findings: [],
    });
    await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(created).toHaveLength(0);
  });

  it("dedupes repeated citations within a single run", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1", "f2"]) }],
      findings: [
        { id: "f1", evidence: evidence(["src/a.ts"]), confidence: 0.6 },
        { id: "f2", evidence: evidence(["src/a.ts", "src/b.ts"]), confidence: 0.9 },
      ],
    });
    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(created).toHaveLength(2);
    const paths = created.map((c) => c.filePath).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    // The duplicated path keeps the highest finding confidence.
    expect(created.find((c) => c.filePath === "src/a.ts")!.confidence).toBe(0.9);
    expect(summary.linksCreated).toBe(2);
  });

  it("does not re-create a link that already exists (idempotent re-run)", async () => {
    const existing: MappingRow = {
      requirementId: "req-1",
      projectId,
      codeSymbolId: null,
      filePath: "src/a.ts",
      startLine: null,
      endLine: null,
      confidence: 0.5,
      source: ANALYSIS_GROUNDING_SOURCE,
    };
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [{ id: "f1", evidence: evidence(["src/a.ts", "src/c.ts"]), confidence: 0.7 }],
      mappings: [existing],
    });
    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    // src/a.ts already present (skipped), src/c.ts is new (created).
    expect(created).toHaveLength(1);
    expect(created[0]!.filePath).toBe("src/c.ts");
    expect(summary).toEqual({ requirementsSeeded: 1, linksCreated: 1, linksSkipped: 1 });
  });

  it("does not collide with a pre-existing symbol-bound row for the same path", async () => {
    // A semantic row WITH a symbol id should not block seeding a file-only row;
    // they are distinct (codeSymbolId differs). The seeder only dedupes against
    // existing file-only rows.
    const symbolRow: MappingRow = {
      requirementId: "req-1",
      projectId,
      codeSymbolId: "sym-1",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 5,
      confidence: 0.8,
      source: "semantic",
    };
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [{ id: "f1", evidence: evidence(["src/a.ts"]), confidence: 0.6 }],
      mappings: [symbolRow],
    });
    await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.filePath).toBe("src/a.ts");
  });

  it("skips requirements that do not exist in the project (cross-project safety)", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId: "other", labels: labels(["f1"]) }],
      findings: [{ id: "f1", evidence: evidence(["src/a.ts"]), confidence: 0.6 }],
    });
    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );
    expect(created).toHaveLength(0);
    expect(summary.requirementsSeeded).toBe(0);
  });
});
