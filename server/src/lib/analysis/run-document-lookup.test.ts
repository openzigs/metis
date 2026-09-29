/**
 * #384 — the per-run document lookups: an id already confirmed, or present in
 * the loaded list, costs no query; the id check's `in` list is capped.
 */
import { describe, expect, it, vi } from "vitest";
import { repairFindingsAnswerWithDocuments } from "./findings-repair.js";
import { MAX_DOCUMENT_ID_LOOKUP, createRunDocumentLookup } from "./run-document-lookup.js";

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

  it("answers from the loaded document list without a query", async () => {
    const q = queries();
    const lookup = createRunDocumentLookup(q);
    await lookup.loadKnownDocuments();
    const found = await lookup.findKnownDocumentIds(["doc_spec_00000001", "doc_unknown_00001"]);
    expect(found).toEqual(["doc_spec_00000001"]);
    expect(q.findDocumentIds).not.toHaveBeenCalled();
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
