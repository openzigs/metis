/**
 * #2236 — the document a clarification record is indexed as, and the index
 * step's edges. The round trip into `documents` is
 * `tests/clarification-knowledge-2236.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoredClarification } from "./clarification-records.js";

const db = vi.hoisted(() => {
  const d = {
    document: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    clarificationRecord: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(),
  };
  d.$transaction.mockImplementation(async (fn: (tx: typeof d) => unknown) => fn(d));
  return d;
});
vi.mock("../prisma.js", () => ({ prisma: db }));

const {
  clarificationTitle,
  indexClarification,
  inertLine,
  renderClarificationDocument,
  withdrawClarification,
} = await import("./clarification-knowledge.js");

function record(over: Partial<StoredClarification> = {}): StoredClarification {
  return {
    id: "rec-1",
    projectId: "p1",
    origin: "analysis",
    questionKey: "k",
    analysisId: "a1",
    specKitFeature: null,
    questionId: "q1",
    question: "How long must a password be?",
    answer: "At least 12 characters.",
    answeredById: "u1",
    answeredAt: new Date("2026-11-11T00:00:00.000Z"),
    ambiguityField: "minimumLength",
    source: null,
    requirementIds: ["R-1"],
    productIds: [],
    status: "settled",
    reopenedAt: null,
    knowledgeDocumentId: null,
    ...over,
  };
}

describe("#2236 — the clarification document", () => {
  it("keeps an answer to one inert line: no code fence, tag or comment", () => {
    expect(inertLine("```js\nalert(1)\n``` <!-- x --> <script>")).toBe(
      "'''js alert(1) ''' &lt;!-- x --> &lt;script>",
    );
  });

  it("names the question in the title, clipped", () => {
    expect(clarificationTitle(record())).toBe("Clarification: How long must a password be?");
    const long = clarificationTitle(record({ question: "x".repeat(300) }));
    expect(long).toBe(`Clarification: ${"x".repeat(120)}…`);
  });

  it("says where it was asked, what it applies to, and quotes the paragraph", () => {
    const md = renderClarificationDocument(
      record({
        answer: "Twelve.\n\n# Not a heading",
        source: { filename: "frd.docx", headingPath: ["4 Accounts"], quote: "Long enough." },
      }),
    );
    expect(md).toContain("- Asked in: requirements analysis a1");
    expect(md).toContain("- Applies to requirements: R-1");
    expect(md).toContain("- Source: frd.docx › 4 Accounts");
    expect(md).toContain("**Answer:** Twelve. # Not a heading");
    expect(md).toContain("**Source paragraph:** Long enough.");
    const specKit = renderClarificationDocument(
      record({ origin: "spec-kit", specKitFeature: "001-export", requirementIds: [] }),
    );
    expect(specKit).toContain("- Asked in: Spec Kit /clarify (feature 001-export)");
    expect(specKit).not.toContain("Applies to requirements");
    expect(specKit).not.toContain("Source paragraph");
  });
});

describe("#2236 — indexClarification edges", () => {
  it("indexes nothing without a user to attribute the document to", async () => {
    const storage = { write: vi.fn() };
    expect(await indexClarification(record({ answeredById: null }), { storage })).toBeNull();
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("never throws: a failed write is logged and reads as not indexed", async () => {
    const storage = {
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const enqueue = vi.fn();
    expect(await indexClarification(record(), { storage, enqueue })).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.document.create).not.toHaveBeenCalled();
  });

  it("copies the source document's ACL onto the clarification document, scoped to the project", async () => {
    const acl = JSON.stringify([{ kind: "role", value: "legal" }]);
    db.document.findFirst.mockResolvedValueOnce({ aclSubjects: acl });
    db.document.create.mockResolvedValueOnce({ id: "doc-new" });
    const storage = {
      write: vi.fn(async () => ({ sizeBytes: 1, storagePath: "p", checksum: "c" })),
    };
    const id = await indexClarification(
      record({
        source: { documentId: "doc-src", filename: "f.docx", headingPath: [], quote: "q" },
      }),
      { storage: storage as never, enqueue: vi.fn() },
    );
    expect(id).toBe("doc-new");
    expect(db.document.findFirst).toHaveBeenCalledWith({
      where: { id: "doc-src", projectId: "p1" },
      select: { aclSubjects: true },
    });
    expect(db.document.create.mock.calls.at(-1)![0].data.aclSubjects).toBe(acl);
  });

  const storage = () => ({
    write: vi.fn(async () => ({ sizeBytes: 7, storagePath: "p", checksum: "c" })),
  });

  it("#2310 — is its own source, with the upload audit entry, by the person who answered", async () => {
    db.document.create.mockResolvedValueOnce({ id: "doc-new" });
    await indexClarification(record(), { storage: storage() as never, enqueue: vi.fn() });
    const created = db.document.create.mock.calls.at(-1)![0].data;
    expect(created).toMatchObject({ source: "clarification", uploadedById: "u1", projectId: "p1" });
    const audit = db.auditLog.create.mock.calls.at(-1)![0].data;
    expect(audit).toMatchObject({
      actorId: "u1",
      action: "document.upload",
      targetType: "document",
      targetId: "doc-new",
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({
      projectId: "p1",
      source: "clarification",
      clarificationId: "rec-1",
    });
  });

  it("#2310 — writes the new document before deleting the old, so a failed write keeps the old one linked", async () => {
    const deleteDocument = vi.fn(async (_id: string): Promise<void> => undefined);
    const failing = {
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    expect(
      await indexClarification(record({ knowledgeDocumentId: "doc-old" }), {
        storage: failing,
        deleteDocument,
        enqueue: vi.fn(),
      }),
    ).toBeNull();
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(db.clarificationRecord.updateMany).not.toHaveBeenCalled();

    // A successful write links the new one in place of the old, then deletes the old.
    db.document.create.mockResolvedValueOnce({ id: "doc-new" });
    const order: string[] = [];
    db.clarificationRecord.updateMany.mockImplementationOnce(async () => {
      order.push("link");
      return { count: 1 };
    });
    deleteDocument.mockImplementation(async (id: string) => {
      order.push(`delete ${id}`);
    });
    expect(
      await indexClarification(record({ knowledgeDocumentId: "doc-old" }), {
        storage: storage() as never,
        deleteDocument,
        enqueue: vi.fn(),
      }),
    ).toBe("doc-new");
    expect(order).toEqual(["link", "delete doc-old"]);
    expect(db.clarificationRecord.updateMany).toHaveBeenCalledWith({
      where: { projectId: "p1", id: "rec-1", knowledgeDocumentId: "doc-old" },
      data: { knowledgeDocumentId: "doc-new" },
    });
  });

  it("#2310 — a concurrent index that linked first wins: this copy is withdrawn, not linked or queued", async () => {
    db.document.create.mockResolvedValueOnce({ id: "doc-late" });
    db.clarificationRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    const deleteDocument = vi.fn(async () => undefined);
    const enqueue = vi.fn();
    expect(
      await indexClarification(record(), {
        storage: storage() as never,
        deleteDocument,
        enqueue,
      }),
    ).toBeNull();
    expect(deleteDocument).toHaveBeenCalledWith("doc-late");
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Adversarial panel on #2430 — after the link moved, nothing names the old
  // document: a failed enqueue must still delete it, or it is never removed.
  it("#2310 — a failed enqueue still deletes the superseded document, and reads as not indexed", async () => {
    db.document.create.mockResolvedValueOnce({ id: "doc-new" });
    const deleteDocument = vi.fn(async (_id: string): Promise<void> => undefined);
    const enqueue = vi.fn(async () => {
      throw new Error("queue down");
    });
    expect(
      await indexClarification(record({ knowledgeDocumentId: "doc-old" }), {
        storage: storage() as never,
        deleteDocument,
        enqueue,
      }),
    ).toBeNull();
    expect(enqueue).toHaveBeenCalledWith("doc-new");
    expect(deleteDocument).toHaveBeenCalledWith("doc-old");
  });

  it("#2310 — a superseded document that cannot be deleted leaves the new one linked", async () => {
    db.document.create.mockResolvedValueOnce({ id: "doc-new" });
    const deleteDocument = vi.fn(async () => {
      throw new Error("store down");
    });
    expect(
      await indexClarification(record({ knowledgeDocumentId: "doc-old" }), {
        storage: storage() as never,
        deleteDocument,
        enqueue: vi.fn(),
      }),
    ).toBe("doc-new");
  });
});

describe("#2236 — withdrawClarification", () => {
  it("deletes a reopened record's document and unlinks it, scoped to the project", async () => {
    db.clarificationRecord.updateMany.mockClear();
    const deleteDocument = vi.fn(async () => undefined);
    expect(
      await withdrawClarification(record({ knowledgeDocumentId: "doc-9" }), { deleteDocument }),
    ).toBe(true);
    expect(deleteDocument).toHaveBeenCalledWith("doc-9");
    expect(db.clarificationRecord.updateMany).toHaveBeenCalledWith({
      where: { projectId: "p1", id: "rec-1" },
      data: { knowledgeDocumentId: null },
    });
  });

  it("does nothing for a record never indexed, and never throws: a failed delete keeps the link", async () => {
    db.clarificationRecord.updateMany.mockClear();
    const deleteDocument = vi.fn(async () => {
      throw new Error("store down");
    });
    expect(await withdrawClarification(record(), { deleteDocument })).toBe(false);
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(
      await withdrawClarification(record({ knowledgeDocumentId: "doc-9" }), { deleteDocument }),
    ).toBe(false);
    expect(db.clarificationRecord.updateMany).not.toHaveBeenCalled();
  });
});
