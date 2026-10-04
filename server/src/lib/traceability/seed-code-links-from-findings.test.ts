/**
 * Tests for the analysis-grounding requirement→code seeder
 * (branch feat/req-code-traceability).
 *
 * The seeding logic is exercised with an in-memory fake Prisma (matching the
 * DI pattern of backfill-spec-links / traceability-spine tests) so no DB is
 * needed. Covers: requires a resolvable code symbol, separates code and document
 * citations, reconciles stale auto-links, preserves curated rows, dedupes reruns,
 * and retains the conservative source/confidence values.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_GROUNDING_SOURCE,
  DEFAULT_SEED_CONFIDENCE,
  parseEvidenceFindingIds,
  parseFindingCitations,
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
  id: string;
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: string;
}

interface DocumentRow {
  id: string;
  projectId: string;
  source: string;
  filename: string;
}

interface CodeSymbolRow {
  id: string;
  projectId: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** Build an in-memory fake Prisma with the three models the seeder touches. */
function makeFakePrisma(opts: {
  requirements: ReqRow[];
  findings: FindingRow[];
  documents?: DocumentRow[];
  codeSymbols?: CodeSymbolRow[];
  mappings?: MappingRow[];
  createError?: Error;
}): { prisma: SeedDeps["prisma"]; created: MappingRow[]; all: MappingRow[] } {
  const mappings: MappingRow[] = (opts.mappings ?? []).map((mapping, index) => ({
    ...mapping,
    id: mapping.id || `existing-${index}`,
  }));
  const created: MappingRow[] = [];
  const codeSymbols =
    opts.codeSymbols ??
    [
      ...new Set(
        opts.findings.flatMap((finding) =>
          parseFindingCitations(finding.evidence).flatMap((citation) =>
            citation.kind === "code" ? [citation.filePath] : [],
          ),
        ),
      ),
    ].map((filePath, index) => ({
      id: `module-${index}`,
      projectId: "proj-1",
      kind: "module",
      filePath,
      startLine: 1,
      endLine: 100,
    }));

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
    document: {
      findMany: async ({ where }: { where: { id: { in: string[] }; projectId: string } }) =>
        (opts.documents ?? []).filter(
          (document) => where.id.in.includes(document.id) && document.projectId === where.projectId,
        ),
    },
    codeSymbol: {
      findMany: async ({
        where,
      }: {
        where: {
          projectId: string;
          kind?: string;
          id?: { in: string[] };
          filePath?: { in: string[] };
        };
      }) =>
        codeSymbols.filter(
          (symbol) =>
            symbol.projectId === where.projectId &&
            (where.kind === undefined || symbol.kind === where.kind) &&
            (where.id === undefined || where.id.in.includes(symbol.id)) &&
            (where.filePath === undefined || where.filePath.in.includes(symbol.filePath)),
        ),
    },
    requirementCodeMapping: {
      findMany: async ({ where }: { where: { requirementId: string; projectId: string } }) =>
        mappings.filter(
          (m) => m.requirementId === where.requirementId && m.projectId === where.projectId,
        ),
      create: async ({ data }: { data: MappingRow }) => {
        if (opts.createError) throw opts.createError;
        const row = { ...data, id: `created-${created.length}` };
        mappings.push(row);
        created.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        const count = mappings.filter((mapping) => ids.has(mapping.id)).length;
        for (let index = mappings.length - 1; index >= 0; index -= 1) {
          if (ids.has(mappings[index]!.id)) mappings.splice(index, 1);
        }
        return { count };
      },
    },
  } as unknown as SeedDeps["prisma"];

  return { prisma, created, all: mappings };
}

function labels(findingIds: string[], extra: string[] = []): string {
  return JSON.stringify([...extra, ...findingIds.map((id) => `finding:${id}`)]);
}

function rawEvidence(citations: unknown[]): string {
  return JSON.stringify({
    citations,
    tags: [],
    requirementId: null,
  });
}

function evidence(filePaths: (string | undefined)[]): string {
  return rawEvidence(
    filePaths.map((filePath, index) =>
      filePath === undefined
        ? { documentId: `doc-${index}`, chunkIndex: index }
        : { filePath, startLine: 1, endLine: 5 },
    ),
  );
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

describe("parseFindingCitations", () => {
  it("keeps code and document citation shapes distinct", () => {
    expect(
      parseFindingCitations(
        rawEvidence([
          { filePath: "src/a.ts", startLine: 2, endLine: 4, symbolId: "symbol-a" },
          { documentId: "doc-1", chunkIndex: 3, filename: "api.html" },
        ]),
      ),
    ).toEqual([
      {
        kind: "code",
        filePath: "src/a.ts",
        startLine: 2,
        endLine: 4,
        symbolId: "symbol-a",
      },
      { kind: "document", documentId: "doc-1", filename: "api.html" },
    ]);
  });

  it("returns [] for null / malformed / invalid citation data", () => {
    expect(parseFindingCitations(null)).toEqual([]);
    expect(parseFindingCitations("nope")).toEqual([]);
    expect(parseFindingCitations(JSON.stringify({ citations: "x" }))).toEqual([]);
    expect(parseFindingCitations(JSON.stringify({}))).toEqual([]);
    expect(
      parseFindingCitations(rawEvidence([{ filePath: "src/a.ts", startLine: 0, endLine: 4 }])),
    ).toEqual([]);
  });
});

describe("seedRequirementCodeLinksFromFindings", () => {
  const projectId = "proj-1";

  it("creates a symbol-bound mapping from a resolvable code citation", async () => {
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
      codeSymbolId: "module-0",
      filePath: "src/auth.ts",
      startLine: 1,
      endLine: 5,
      confidence: 0.9,
      source: ANALYSIS_GROUNDING_SOURCE,
    });
  });

  it("resolves repo document citations through their source path and module symbol", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [
        {
          id: "f1",
          evidence: rawEvidence([
            {
              documentId: "repo-doc",
              chunkIndex: 0,
              filename: "untrusted display name",
            },
          ]),
          confidence: 0.8,
        },
      ],
      documents: [
        {
          id: "repo-doc",
          projectId,
          source: "repo",
          filename: "connector:repo:repo-1:src/internal/auth.ts",
        },
      ],
      codeSymbols: [
        {
          id: "module-auth",
          projectId,
          kind: "module",
          filePath: "internal/auth.ts",
          startLine: 1,
          endLine: 92,
        },
      ],
    });

    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );

    expect(summary.linksCreated).toBe(1);
    expect(created[0]).toMatchObject({
      codeSymbolId: "module-auth",
      filePath: "internal/auth.ts",
      startLine: 1,
      endLine: 92,
    });
  });

  it("does not promote upload or database document citations to code links", async () => {
    const { prisma, created } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [
        {
          id: "f1",
          evidence: rawEvidence([
            {
              documentId: "upload-doc",
              chunkIndex: 0,
              filename: "connector:repo:spoofed:src/src/auth.ts",
            },
            {
              documentId: "db-doc",
              chunkIndex: 1,
              filename: "connector:repo:spoofed:src/src/auth.ts",
            },
          ]),
          confidence: 0.9,
        },
      ],
      documents: [
        {
          id: "upload-doc",
          projectId,
          source: "upload",
          filename: "connector:repo:spoofed:src/src/auth.ts",
        },
        {
          id: "db-doc",
          projectId,
          source: "db",
          filename: "connector:repo:spoofed:src/src/auth.ts",
        },
      ],
      codeSymbols: [
        {
          id: "module-auth",
          projectId,
          kind: "module",
          filePath: "src/auth.ts",
          startLine: 1,
          endLine: 100,
        },
      ],
    });

    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );

    expect(summary).toEqual({ requirementsSeeded: 0, linksCreated: 0, linksSkipped: 0 });
    expect(created).toHaveLength(0);
  });

  it("ignores repo paths with no unique module symbol and reconciles stale auto-links", async () => {
    const legacy: MappingRow = {
      id: "mapping-legacy",
      requirementId: "req-1",
      projectId,
      codeSymbolId: null,
      filePath: "missing.ts",
      startLine: null,
      endLine: null,
      confidence: 0.7,
      source: ANALYSIS_GROUNDING_SOURCE,
    };
    const { prisma, created, all } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [
        {
          id: "f1",
          evidence: rawEvidence([
            {
              documentId: "missing-doc",
              chunkIndex: 0,
              filename: "connector:repo:r1:src/missing.ts",
            },
            {
              documentId: "ambiguous-doc",
              chunkIndex: 1,
              filename: "connector:repo:r1:src/ambiguous.ts",
            },
          ]),
          confidence: 0.7,
        },
      ],
      documents: [
        { id: "missing-doc", projectId, source: "repo", filename: "missing.ts" },
        { id: "ambiguous-doc", projectId, source: "repo", filename: "ambiguous.ts" },
      ],
      codeSymbols: [
        {
          id: "module-a",
          projectId,
          kind: "module",
          filePath: "ambiguous.ts",
          startLine: 1,
          endLine: 10,
        },
        {
          id: "module-b",
          projectId,
          kind: "module",
          filePath: "ambiguous.ts",
          startLine: 1,
          endLine: 10,
        },
      ],
      mappings: [legacy],
    });

    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );

    expect(summary).toEqual({ requirementsSeeded: 0, linksCreated: 0, linksSkipped: 0 });
    expect(created).toHaveLength(0);
    expect(all).toHaveLength(0);
  });

  it("replaces legacy file-only rows and preserves manual mappings", async () => {
    const { prisma, created, all } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [
        {
          id: "f1",
          evidence: rawEvidence([
            {
              documentId: "repo-doc",
              chunkIndex: 0,
              filename: "untrusted display name",
            },
          ]),
          confidence: 0.8,
        },
      ],
      documents: [
        {
          id: "repo-doc",
          projectId,
          source: "repo",
          filename: "connector:repo:repo-1:src/internal/auth.ts",
        },
      ],
      codeSymbols: [
        {
          id: "module-auth",
          projectId,
          kind: "module",
          filePath: "internal/auth.ts",
          startLine: 1,
          endLine: 92,
        },
      ],
      mappings: [
        {
          id: "legacy-file-only",
          requirementId: "req-1",
          projectId,
          codeSymbolId: null,
          filePath: "internal/auth.ts",
          startLine: null,
          endLine: null,
          confidence: 0.6,
          source: ANALYSIS_GROUNDING_SOURCE,
        },
        {
          id: "manual-doc",
          requirementId: "req-1",
          projectId,
          codeSymbolId: null,
          filePath: "api.html",
          startLine: null,
          endLine: null,
          confidence: 0.9,
          source: "manual",
        },
      ],
    });

    const summary = await seedRequirementCodeLinksFromFindings(
      { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
      { prisma },
    );

    expect(summary.linksCreated).toBe(1);
    expect(created[0]).toMatchObject({ codeSymbolId: "module-auth", filePath: "internal/auth.ts" });
    expect(all).toHaveLength(2);
    expect(all.find((mapping) => mapping.source === "manual")?.filePath).toBe("api.html");
  });

  it("keeps stale auto-links when creating a replacement fails", async () => {
    const legacy: MappingRow = {
      id: "legacy-file-only",
      requirementId: "req-1",
      projectId,
      codeSymbolId: null,
      filePath: "src/old.ts",
      startLine: null,
      endLine: null,
      confidence: 0.6,
      source: ANALYSIS_GROUNDING_SOURCE,
    };
    const { prisma, all } = makeFakePrisma({
      requirements: [{ id: "req-1", projectId, labels: labels(["f1"]) }],
      findings: [
        {
          id: "f1",
          evidence: rawEvidence([{ filePath: "src/new.ts", startLine: 3, endLine: 5 }]),
          confidence: 0.8,
        },
      ],
      mappings: [legacy],
      createError: new Error("mapping create failed"),
    });

    await expect(
      seedRequirementCodeLinksFromFindings(
        { analysisId: "an-1", projectId, requirementIds: ["req-1"] },
        { prisma },
      ),
    ).rejects.toThrow("mapping create failed");
    expect(all).toEqual([legacy]);
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

  it("creates none when the finding has no citations", async () => {
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
      id: "mapping-existing",
      requirementId: "req-1",
      projectId,
      codeSymbolId: "module-0",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 5,
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
    // The exact resolved module link already exists; only src/c.ts is new.
    expect(created).toHaveLength(1);
    expect(created[0]!.filePath).toBe("src/c.ts");
    expect(summary).toEqual({ requirementsSeeded: 1, linksCreated: 1, linksSkipped: 1 });
  });

  it("does not collide with a pre-existing symbol-bound row for the same path", async () => {
    // A different semantic symbol for the same path is a distinct mapping.
    const symbolRow: MappingRow = {
      id: "mapping-semantic",
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
