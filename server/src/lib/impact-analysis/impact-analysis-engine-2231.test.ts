/**
 * #2231 — an impact run on a document reads the document, not its chunks
 * re-joined; with the document reader wired, each requirement it finds is one
 * change. Every assertion reads what the engine PERSISTED (the items and the
 * run's summary), the rows the read path and the UI read.
 */
import { describe, expect, it, vi } from "vitest";
import type { DocumentReading, ReadStatement } from "../document-reader/reader.js";
import type { ChangedRequirement } from "./extract-changes.js";
import { jobEvents } from "../socket/job-events.js";
import { executeImpactAnalysis, InMemoryCodeGraphDataSource } from "./impact-analysis-engine.js";
import { currentImpactProjectId } from "./impact-llm-scope.js";

const FRD = [
  "# Clinic booking FRD",
  "",
  "## 1 Purpose",
  "",
  "This portal lets a patient book an appointment without calling the clinic.",
  "",
  "## 2 Access",
  "",
  "The portal shall lock an account after five failed attempts.",
  "",
  "## 3 Booking",
  "",
  "A patient shall hold at most two future appointments at any time.",
].join("\n");

/** The chunks the RAG store holds for {@link FRD}: they overlap. */
const CHUNKS = [
  "# Clinic booking FRD\n\n## 1 Purpose\n\nThis portal lets a patient book an appointment without calling the clinic.",
  "without calling the clinic.\n\n## 2 Access\n\nThe portal shall lock an account after five failed attempts.",
];

const graph = new InMemoryCodeGraphDataSource(
  [
    {
      id: "A",
      qualifiedName: "auth.lockAccount",
      kind: "function",
      filePath: "auth.ts",
      language: "ts",
      startLine: 1,
      endLine: 9,
    },
  ],
  [],
);

function prismaMock(run: { sourceText: string | null; documentId: string | null }) {
  const analyses = new Map<string, Record<string, unknown>>([["ia", { id: "ia", ...run }]]);
  const items: Array<Record<string, unknown>> = [];
  const prisma = {
    impactAnalysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => analyses.get(where.id)),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          analyses.set(where.id, { ...analyses.get(where.id), ...data });
          return analyses.get(where.id);
        },
      ),
    },
    impactItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `item-${items.length}`, ...data };
        items.push(row);
        return row;
      }),
    },
    impactAffectedSymbol: { createMany: vi.fn(async () => ({ count: 1 })) },
    impactAffectedTable: { createMany: vi.fn(async () => ({ count: 0 })) },
    document: {
      findUnique: vi.fn(async () => ({
        projectId: "proj-docs",
        checksum: "sum-frd",
        filename: "frd.md",
        title: "Clinic booking FRD",
        mimeType: "text/markdown",
        storagePath: "docs/frd.md",
      })),
    },
    knowledgeChunk: { findMany: vi.fn(async () => CHUNKS.map((text) => ({ text }))) },
    quarantineChunk: { findMany: vi.fn(async () => []) },
    codeSymbol: {},
    codeEdge: {},
  };
  return { prisma, analyses, items };
}

const storage = { read: vi.fn(async () => Buffer.from(FRD, "utf8")) };

function statement(over: Partial<ReadStatement>): ReadStatement {
  return {
    id: "T1",
    kind: "requirement",
    statement: "Lock an account after five failed sign-in attempts.",
    quote: "The portal shall lock an account after five failed attempts.",
    start: 0,
    end: 1,
    sectionId: "S3",
    headingPath: ["Clinic booking FRD", "2 Access"],
    refersTo: [],
    ...over,
  };
}

const READING: DocumentReading = {
  mode: "whole",
  statements: [
    statement({
      id: "T1",
      kind: "background",
      statement: "Patients book without calling.",
      sectionId: "S2",
      headingPath: ["Clinic booking FRD", "1 Purpose"],
    }),
    statement({ id: "T2" }),
    statement({
      id: "T3",
      kind: "business-rule",
      statement: "A patient holds at most two future appointments.",
      quote: "A patient shall hold at most two future appointments at any time.",
      sectionId: "S4",
      headingPath: ["Clinic booking FRD", "3 Booking"],
    }),
  ],
  sections: [
    {
      sectionId: "S1",
      headingPath: ["Clinic booking FRD"],
      start: 0,
      end: 1,
      status: "read",
      kinds: {},
      statements: 0,
      unverified: 0,
      repeats: 0,
    },
    {
      sectionId: "S2",
      headingPath: ["Clinic booking FRD", "1 Purpose"],
      start: 1,
      end: 2,
      status: "read",
      kinds: { background: 1 },
      statements: 1,
      unverified: 0,
      repeats: 0,
    },
    {
      sectionId: "S3",
      headingPath: ["Clinic booking FRD", "2 Access"],
      start: 2,
      end: 3,
      status: "read",
      kinds: { requirement: 1 },
      statements: 1,
      unverified: 0,
      repeats: 0,
    },
    {
      sectionId: "S4",
      headingPath: ["Clinic booking FRD", "3 Booking"],
      start: 3,
      end: 4,
      status: "read",
      kinds: { "business-rule": 1 },
      statements: 1,
      unverified: 0,
      repeats: 0,
    },
  ],
  droppedUnverified: 0,
  merge: "done",
  calls: 2,
  outputTokenCap: 8192,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

/** Every change hits the one symbol, so every change writes an item. */
const mapRequirement = vi.fn(async (_req: { id: string; title: string; body: string }) => [
  {
    codeSymbolId: "A",
    filePath: "auth.ts",
    qualifiedName: "auth.lockAccount",
    startLine: 1,
    endLine: 9,
    confidence: 0.9,
  },
]);

async function run(
  prisma: ReturnType<typeof prismaMock>["prisma"],
  deps: Record<string, unknown> = {},
): Promise<void> {
  await executeImpactAnalysis("ia", ["proj-1"], {
    prisma: prisma as never,
    mapRequirement,
    dataSourceFor: () => graph,
    includeSchemaImpact: false,
    documentStorage: storage,
    ...deps,
  });
}

describe("impact analysis on a document (#2231)", () => {
  it("reads the document's file, not its overlapping chunks re-joined", async () => {
    const { prisma, analyses } = prismaMock({ sourceText: null, documentId: "doc-1" });
    const extract = vi.fn(async (_text: string): Promise<ChangedRequirement[]> => []);
    await run(prisma, { extractor: { extract } });
    expect(analyses.get("ia")?.status).toBe("completed");
    expect(storage.read).toHaveBeenCalledWith("docs/frd.md");
    expect(extract).toHaveBeenCalledWith(FRD);
    expect(prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  it("with the reader: one change per requirement, constraint or business rule, and says what it read", async () => {
    const { prisma, analyses, items } = prismaMock({ sourceText: null, documentId: "doc-1" });
    const documentReader = vi.fn(async () => READING);
    const extract = vi.fn(async (): Promise<ChangedRequirement[]> => []);
    await run(prisma, { documentReader, extractor: { extract } });

    // #2280 — with the stored document's key, so a saved reading of it can be reused.
    expect(documentReader).toHaveBeenCalledWith({
      title: "Clinic booking FRD",
      text: FRD,
      document: { projectId: "proj-docs", documentId: "doc-1", checksum: "sum-frd" },
    });
    expect(extract).not.toHaveBeenCalled();
    expect(items.map((i) => i.requirementTitle)).toEqual([
      "Lock an account after five failed sign-in attempts.",
      "A patient holds at most two future appointments.",
    ]);
    // The code search reads each change with its section and the source's words.
    expect(mapRequirement.mock.calls.at(-2)![0].body).toBe(
      "Lock an account after five failed sign-in attempts.\n\n" +
        "Section: Clinic booking FRD › 2 Access\n" +
        "> The portal shall lock an account after five failed attempts.",
    );
    const summary = String(analyses.get("ia")?.summary);
    expect(summary).toContain("from 2 change(s).");
    expect(summary).toContain(
      "\n\nThe model read the document (4 sections) and found 1 requirement, 1 business rule; each is analysed as one change.",
    );
    expect(summary).toContain(
      '2 sections held none: "Clinic booking FRD", "Clinic booking FRD › 1 Purpose".',
    );
  });

  it("falls back to the splitter, and says so, when the reading fails", async () => {
    const { prisma, analyses, items } = prismaMock({ sourceText: null, documentId: "doc-1" });
    const documentReader = vi.fn(async () => {
      throw new Error("provider down");
    });
    await run(prisma, { documentReader });
    expect(analyses.get("ia")?.status).toBe("completed");
    // The default splitter read the parsed file: one change per paragraph.
    expect(items.length).toBeGreaterThan(0);
    expect(String(analyses.get("ia")?.summary)).toContain(
      "\n\nThe model could not read the document, so its changes were split by paragraph and bullet instead",
    );
  });

  it("keeps the splitter for pasted short text, and reads long pasted prose with the model", async () => {
    const short = prismaMock({
      sourceText: "Lock accounts after five failures.",
      documentId: null,
    });
    const documentReader = vi.fn(async () => READING);
    await run(short.prisma, { documentReader });
    expect(documentReader).not.toHaveBeenCalled();
    expect(short.items.map((i) => i.requirementTitle)).toEqual([
      "Lock accounts after five failures.",
    ]);
    expect(String(short.analyses.get("ia")?.summary)).not.toContain("The model read");

    const prose = `${FRD}\n\n${"Further context on how the clinic works today. ".repeat(50)}`;
    const long = prismaMock({ sourceText: prose, documentId: null });
    await run(long.prisma, { documentReader });
    expect(documentReader).toHaveBeenCalledWith({ title: "Pasted text", text: prose });
    expect(long.prisma.document.findUnique).not.toHaveBeenCalled();
    expect(String(long.analyses.get("ia")?.summary)).toContain("The model read the pasted text");
  });
});

describe("#2276 — the reading waits on what the run will search", () => {
  it("an empty source beside stored requirements reads nothing and splits nothing", async () => {
    const { prisma, items } = prismaMock({ sourceText: "   ", documentId: null });
    const requirement = {
      findMany: vi.fn(async () => [
        { id: "req-1", title: "Lock accounts", body: "After five failed attempts." },
      ]),
    };
    prisma.impactAnalysis.findFirst.mockResolvedValueOnce({
      id: "ia",
      sourceText: "   ",
      documentId: null,
      requirementIds: JSON.stringify(["req-1"]),
    });
    const documentReader = vi.fn(async () => READING);
    const extract = vi.fn(async (): Promise<ChangedRequirement[]> => []);
    await run({ ...prisma, requirement } as never, { documentReader, extractor: { extract } });
    expect(documentReader).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(items.map((i) => i.requirementTitle)).toEqual(["Lock accounts"]);
  });

  it("does not read the document when every project is restricted or deleted", async () => {
    const { prisma, analyses, items } = prismaMock({ sourceText: null, documentId: "doc-1" });
    const documentReader = vi.fn(async () => READING);
    await executeImpactAnalysis("ia", ["proj-1", "proj-2"], {
      prisma: prisma as never,
      mapRequirement,
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
      documentStorage: storage,
      documentReader,
      projectAccess: async (projectId) => (projectId === "proj-1" ? "restricted" : "deleted"),
    });
    expect(documentReader).not.toHaveBeenCalled();
    expect(analyses.get("ia")?.status).toBe("completed");
    expect(items).toEqual([]);
    expect(String(analyses.get("ia")?.summary)).not.toContain("The model");
  });

  it("does not read the document when no accessible project has indexed symbols", async () => {
    const { prisma, analyses } = prismaMock({ sourceText: null, documentId: "doc-1" });
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn(async () => []);
    const documentReader = vi.fn(async () => READING);
    await executeImpactAnalysis("ia", ["proj-1"], {
      prisma: { ...prisma, codeSymbol: { findFirst, findMany }, codeEdge: { findMany } } as never,
      mapRequirement,
      includeSchemaImpact: false,
      documentStorage: storage,
      documentReader,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: "proj-1" },
      select: { id: true },
    });
    expect(documentReader).not.toHaveBeenCalled();
    expect(analyses.get("ia")?.status).toBe("completed");
  });

  it("reads once a project will be searched, billed to that project, and reports that it is reading", async () => {
    const { prisma } = prismaMock({ sourceText: null, documentId: "doc-1" });
    const billedTo: Array<string | null> = [];
    const documentReader = vi.fn(async () => {
      billedTo.push(currentImpactProjectId());
      return READING;
    });
    const progress = vi.spyOn(jobEvents, "progress");
    try {
      await executeImpactAnalysis("ia", ["proj-1", "proj-2"], {
        prisma: prisma as never,
        mapRequirement,
        dataSourceFor: () => graph,
        includeSchemaImpact: false,
        documentStorage: storage,
        documentReader,
        projectAccess: async (projectId) => (projectId === "proj-1" ? "restricted" : "accessible"),
      });
      expect(documentReader).toHaveBeenCalledTimes(1);
      expect(billedTo).toEqual(["proj-2"]);
      expect(progress).toHaveBeenCalledWith(
        "impact-analysis",
        "ia",
        null,
        0,
        "Reading the document",
      );
      // Before the per-project progress, not after it.
      const labels = progress.mock.calls.map((c) => c[4]);
      expect(labels.indexOf("Reading the document")).toBeLessThan(labels.indexOf("Project 1/2"));
    } finally {
      progress.mockRestore();
    }
  });
});
