/**
 * #384 — the per-run document lookups: an id already confirmed, or present in
 * the loaded list, costs no query; the id check's `in` list is capped.
 */
import { describe, expect, it, vi } from "vitest";
import { repairFindingsAnswerWithDocuments } from "./findings-repair.js";
import {
  MAX_DOCUMENT_ID_LOOKUP,
  createRunDocumentLookup,
  projectDocumentQueries,
  type DocumentQueryPrisma,
} from "./run-document-lookup.js";

const KNOWN = [
  { id: "doc_loanterms_0001", filename: "Loan Terms.md" },
  { id: "doc_spec_00000001", filename: "Spec.md" },
];

function answer(citations: unknown[]) {
  return {
    agentKey: "code",
    summary: "s",
    findings: [
      { category: "architecture", severity: "medium", title: "t", body: "b", tags: [], citations },
    ],
    notes: [],
  };
}

function queries(docs = KNOWN) {
  const listDocuments = vi.fn(async () => docs);
  const findDocumentIds = vi.fn(async (ids: readonly string[]) =>
    ids.filter((id) => docs.some((d) => d.id === id)),
  );
  return { listDocuments, findDocumentIds };
}

describe("createRunDocumentLookup", () => {
  it("answers a second answer citing the same ids without a query", async () => {
    const q = queries();
    const lookup = createRunDocumentLookup(q);
    const cited = answer([
      { documentId: "doc_loanterms_0001", chunkIndex: 0 },
      { documentId: "doc_spec_00000001", chunkIndex: 1 },
    ]);

    for (let i = 0; i < 2; i++) {
      const { value, repairs } = await repairFindingsAnswerWithDocuments(
        cited,
        lookup.loadKnownDocuments,
        lookup.findKnownDocumentIds,
      );
      expect(value).toEqual(cited);
      expect(repairs).toEqual([]);
    }

    expect(q.findDocumentIds).toHaveBeenCalledTimes(1);
    expect(q.listDocuments).not.toHaveBeenCalled();
  });

  it("queries only the ids not yet confirmed", async () => {
    const q = queries();
    const lookup = createRunDocumentLookup(q);
    await lookup.findKnownDocumentIds(["doc_loanterms_0001"]);
    const found = await lookup.findKnownDocumentIds(["doc_loanterms_0001", "doc_spec_00000001"]);
    expect(found).toEqual(["doc_loanterms_0001", "doc_spec_00000001"]);
    expect(q.findDocumentIds).toHaveBeenLastCalledWith(["doc_spec_00000001"]);
  });

  it("does not remember an id that was not found", async () => {
    const q = queries();
    const lookup = createRunDocumentLookup(q);
    expect(await lookup.findKnownDocumentIds(["doc_unknown_00001"])).toEqual([]);
    expect(await lookup.findKnownDocumentIds(["doc_unknown_00001"])).toEqual([]);
    expect(q.findDocumentIds).toHaveBeenCalledTimes(2);
  });

  it("answers ids in the loaded list without a query, and checks only the ones it lacks", async () => {
    const q = queries();
    const lookup = createRunDocumentLookup(q);
    await lookup.loadKnownDocuments();
    expect(await lookup.findKnownDocumentIds(["doc_spec_00000001"])).toEqual(["doc_spec_00000001"]);
    expect(q.findDocumentIds).not.toHaveBeenCalled();

    const found = await lookup.findKnownDocumentIds(["doc_spec_00000001", "doc_unknown_00001"]);
    expect(found).toEqual(["doc_spec_00000001"]);
    expect(q.findDocumentIds).toHaveBeenCalledTimes(1);
    expect(q.findDocumentIds).toHaveBeenCalledWith(["doc_unknown_00001"]);
  });

  // PR #397 review — the loaded list is a snapshot. A document ingested after it
  // loaded must still count, or its valid citation is dropped by the repair.
  it("keeps a citation to a document ingested after the list loaded", async () => {
    const late = { id: "doc_ingested_late01", filename: "Late.md" };
    const db = [...KNOWN];
    const q = {
      listDocuments: vi.fn(async () => [...db]),
      findDocumentIds: vi.fn(async (ids: readonly string[]) =>
        ids.filter((id) => db.some((d) => d.id === id)),
      ),
    };
    const lookup = createRunDocumentLookup(q);
    await lookup.loadKnownDocuments(); // snapshot without `late`
    db.push(late); // ingested mid-run

    const cited = answer([{ documentId: late.id, chunkIndex: 0 }]);
    const { value, repairs } = await repairFindingsAnswerWithDocuments(
      cited,
      lookup.loadKnownDocuments,
      lookup.findKnownDocumentIds,
    );
    expect(value).toEqual(cited);
    expect(repairs).toEqual([]);
  });

  it("loads the document list at most once", async () => {
    const q = queries();
    const lookup = createRunDocumentLookup(q);
    const first = await lookup.loadKnownDocuments();
    const second = await lookup.loadKnownDocuments();
    expect(second).toBe(first);
    expect(q.listDocuments).toHaveBeenCalledTimes(1);
  });

  it("memoizes a failed load for the rest of the run, and keeps querying ids", async () => {
    const q = queries();
    q.listDocuments.mockRejectedValue(new Error("db down"));
    const lookup = createRunDocumentLookup(q);
    await expect(lookup.loadKnownDocuments()).rejects.toThrow("db down");
    await expect(lookup.loadKnownDocuments()).rejects.toThrow("db down");
    expect(q.listDocuments).toHaveBeenCalledTimes(1);
    expect(await lookup.findKnownDocumentIds(["doc_spec_00000001"])).toEqual(["doc_spec_00000001"]);
    expect(q.findDocumentIds).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failed id check", async () => {
    const q = queries();
    q.findDocumentIds.mockRejectedValueOnce(new Error("db down"));
    const lookup = createRunDocumentLookup(q);
    await expect(lookup.findKnownDocumentIds(["doc_spec_00000001"])).rejects.toThrow("db down");
    expect(await lookup.findKnownDocumentIds(["doc_spec_00000001"])).toEqual(["doc_spec_00000001"]);
  });

  it("caps the id check's list and reports the ids past the cap as not found", async () => {
    const docs = Array.from({ length: MAX_DOCUMENT_ID_LOOKUP + 5 }, (_, i) => ({
      id: `doc_many_${String(i).padStart(8, "0")}`,
      filename: `f${i}.md`,
    }));
    const q = queries(docs);
    const lookup = createRunDocumentLookup(q);
    const ids = docs.map((d) => d.id);

    const found = await lookup.findKnownDocumentIds([...ids, ids[0]!]);

    expect(q.findDocumentIds).toHaveBeenCalledTimes(1);
    expect(q.findDocumentIds.mock.calls[0]![0]).toEqual(ids.slice(0, MAX_DOCUMENT_ID_LOOKUP));
    expect(found).toEqual([...ids.slice(0, MAX_DOCUMENT_ID_LOOKUP), ids[0]]);
  });

  it("resolves an answer citing more ids than the cap through the full list", async () => {
    const docs = Array.from({ length: MAX_DOCUMENT_ID_LOOKUP + 1 }, (_, i) => ({
      id: `doc_many_${String(i).padStart(8, "0")}`,
      filename: `f${i}.md`,
    }));
    const q = queries(docs);
    const lookup = createRunDocumentLookup(q);
    const cited = answer(docs.map((d) => ({ documentId: d.id, chunkIndex: 0 })));

    const { value, repairs } = await repairFindingsAnswerWithDocuments(
      cited,
      lookup.loadKnownDocuments,
      lookup.findKnownDocumentIds,
    );

    expect(value).toEqual(cited);
    expect(repairs).toEqual([]);
    expect(q.listDocuments).toHaveBeenCalledTimes(1);
  });
});

/**
 * #401 — a direct unit-level check of the query shape, alongside the
 * end-to-end assertions in `agentic-findings-repair-pipeline.test.ts`:
 * dropping the project scope or the soft-delete filter from either query must
 * go red here as well as there.
 */
describe("projectDocumentQueries", () => {
  function fakePrisma(rows: unknown[]) {
    const findMany = vi.fn(async (_args: unknown) => rows);
    return { prisma: { document: { findMany } } as unknown as DocumentQueryPrisma, findMany };
  }

  it("lists only the project's live documents", async () => {
    const { prisma, findMany } = fakePrisma(KNOWN);

    const docs = await projectDocumentQueries(prisma, "proj_a").listDocuments();

    expect(docs).toEqual(KNOWN);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: "proj_a", deletedAt: null },
      select: { id: true, filename: true },
    });
  });

  it("checks ids against the project's live documents only", async () => {
    const { prisma, findMany } = fakePrisma([{ id: "doc_spec_00000001" }]);

    const found = await projectDocumentQueries(prisma, "proj_a").findDocumentIds([
      "doc_spec_00000001",
      "doc_other_project",
    ]);

    expect(found).toEqual(["doc_spec_00000001"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj_a",
        deletedAt: null,
        id: { in: ["doc_spec_00000001", "doc_other_project"] },
      },
      select: { id: true },
    });
  });
});
