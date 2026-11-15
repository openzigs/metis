/**
 * #2546 — the document visibility rule outside a run: the reader is resolved
 * only when a document is restricted, an inactive one sees nothing
 * restricted, any other failure rejects, and a document gone fails closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESTRICTED_SOURCE_TITLE } from "@metis/shared";

const findMany = vi.fn();
vi.mock("../prisma.js", () => ({ prisma: { document: { findMany } } }));
const resolveAclActor = vi.fn();
vi.mock("../rag/acl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rag/acl.js")>()),
  resolveAclActor,
}));

const { InactiveAclActorError } = await import("../rag/acl.js");
const { canSeeDocument, documentVisibilityFor, hiddenDocumentIds, restrictedDocumentRow } =
  await import("./document-visibility.js");

const OPEN = { aclSubjects: "[]" };
const ALICE_ONLY = { aclSubjects: JSON.stringify([{ kind: "user", value: "alice" }]) };

describe("#2546 — document visibility outside a run", () => {
  beforeEach(() => {
    findMany.mockReset();
    resolveAclActor.mockReset();
    resolveAclActor.mockImplementation(async (userId: string) => ({
      userId,
      role: userId === "root" ? "admin" : "coordinator",
    }));
  });

  it("never resolves the reader when nothing is restricted", async () => {
    const sees = await documentVisibilityFor("bob", [OPEN, { aclSubjects: null }]);
    expect(sees(OPEN)).toBe(true);
    expect(resolveAclActor).not.toHaveBeenCalled();
  });

  it("shows a restricted document only to who it names, and to an admin", async () => {
    expect(await canSeeDocument("alice", ALICE_ONLY)).toBe(true);
    expect(await canSeeDocument("bob", ALICE_ONLY)).toBe(false);
    expect(await canSeeDocument("root", ALICE_ONLY)).toBe(true);
  });

  it("takes an actor, or a loader, as the reader", async () => {
    const actor = { userId: "alice", role: "coordinator" };
    expect((await documentVisibilityFor(actor, [ALICE_ONLY]))(ALICE_ONLY)).toBe(true);
    const loader = vi.fn(async () => ({ userId: "bob", role: "coordinator" }));
    expect((await documentVisibilityFor(loader, [ALICE_ONLY]))(ALICE_ONLY)).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(resolveAclActor).not.toHaveBeenCalled();
  });

  it("shows an inactive reader nothing restricted, and rejects on any other failure", async () => {
    resolveAclActor.mockRejectedValueOnce(new InactiveAclActorError());
    const sees = await documentVisibilityFor("alice", [ALICE_ONLY, OPEN]);
    expect(sees(ALICE_ONLY)).toBe(false);
    expect(sees(OPEN)).toBe(true);
    resolveAclActor.mockRejectedValueOnce(new Error("database down"));
    await expect(documentVisibilityFor("alice", [ALICE_ONLY])).rejects.toThrow("database down");
  });

  it("names the hidden ids, a document gone among them", async () => {
    findMany.mockResolvedValueOnce([
      { id: "d-open", ...OPEN },
      { id: "d-alice", ...ALICE_ONLY },
    ]);
    const hidden = await hiddenDocumentIds("bob", ["d-open", "d-alice", "d-gone", "d-open"]);
    expect([...hidden].sort()).toEqual(["d-alice", "d-gone"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["d-open", "d-alice", "d-gone"] } },
      select: { id: true, aclSubjects: true },
    });
    expect(await hiddenDocumentIds("bob", [])).toEqual(new Set());
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("reads a long id list in batches of 500", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `d-${i}`);
    findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, ...OPEN })),
    );
    expect(await hiddenDocumentIds("bob", ids)).toEqual(new Set());
    expect(findMany.mock.calls.map((c) => c[0].where.id.in.length)).toEqual([500, 500, 1]);
  });

  it("a restricted row keeps its id and counts, and loses its name, path and error", () => {
    const row = restrictedDocumentRow({
      id: "d",
      filename: "payroll.docx",
      title: "Payroll",
      storagePath: "/data/payroll.docx",
      checksum: "abc",
      errorMessage: "could not parse payroll.docx",
      sizeBytes: 10,
      chunkCount: 2,
    });
    expect(row).toEqual({
      id: "d",
      filename: RESTRICTED_SOURCE_TITLE,
      title: null,
      storagePath: "",
      checksum: "",
      errorMessage: null,
      sizeBytes: 10,
      chunkCount: 2,
      restricted: true,
    });
    // A field the row does not carry is not added.
    expect(restrictedDocumentRow({ filename: "x" })).toEqual({
      filename: RESTRICTED_SOURCE_TITLE,
      restricted: true,
    });
  });
});
