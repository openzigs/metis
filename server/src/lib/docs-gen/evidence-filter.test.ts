import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidencePolicy } from "./evidence-policy.js";

vi.mock("../prisma.js", () => ({ prisma: { knowledgeChunk: { findMany: vi.fn() } } }));
import { prisma } from "../prisma.js";
import { filterPrimaryEvidence } from "./evidence-filter.js";

const policy: EvidencePolicy = {
  projectId: "p1",
  generatedDocumentId: "self",
  actor: { userId: "alice", role: "developer" },
  repoConnectorId: "a",
  codeGraphId: "graph-a",
  sharedDocumentIds: ["reference"],
  allowWebResearch: false,
};
function row(id = "a") {
  return {
    id,
    documentId: `doc-${id}`,
    text: `SQL-${id}`,
    metadata: "{}",
    chunkerIdentity: null as string | null,
    aclSubjects: "[]",
    document: {
      filename: `connector:repo:${id}:src/same.ts`,
      storagePath: "blob",
      aclSubjects: "[]",
    },
  };
}
type Row = ReturnType<typeof row>;
function candidates(rows: Row[]) {
  return rows.map((r) => ({
    chunkId: r.id,
    documentId: r.documentId,
    text: "STALE-DENSE-TEXT",
    filename: "connector:repo:a:src/same.ts",
    score: 0.9,
  }));
}
async function filter(rows: Row[], overrides: Partial<EvidencePolicy> = {}) {
  vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValue(rows as never);
  return filterPrimaryEvidence(candidates(rows), { ...policy, ...overrides });
}
beforeEach(() => vi.clearAllMocks());

describe("SQL-authoritative primary evidence #1353", () => {
  it("disambiguates identical paths by live repository identity and replaces stale dense content", async () => {
    const rows = [row("a"), row("b")];
    expect(await filter(rows)).toEqual([
      { ...candidates(rows)[0], text: "SQL-a", filename: rows[0].document.filename },
    ]);
    expect(prisma.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["a", "b"] },
          projectId: "p1",
          document: { projectId: "p1", deletedAt: null, indexState: "indexed" },
        },
      }),
    );
    expect((await filter(rows, { repoConnectorId: undefined })).map((r) => r.chunkId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not query SQL for empty candidates", async () => {
    expect(await filterPrimaryEvidence([], policy)).toEqual([]);
    expect(prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  it("drops missing live chunks and vector-to-SQL document identity mismatches", async () => {
    vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValue([row()] as never);
    expect(
      await filterPrimaryEvidence(
        [
          { ...candidates([row()])[0], documentId: "foreign-doc" },
          { ...candidates([row()])[0], chunkId: "deleted" },
        ],
        policy,
      ),
    ).toEqual([]);
  });

  it.each(["not-json", "null", "[]", "1", '"string"'])(
    "rejects malformed metadata %s",
    async (metadata) => {
      expect(await filter([{ ...row(), metadata }])).toEqual([]);
    },
  );

  it("accepts absent legacy metadata without trusting the dense index", async () => {
    expect(await filter([{ ...row(), metadata: null as unknown as string }])).toHaveLength(1);
  });

  it.each([
    ["current document id", { documentId: "gendoc-self" }],
    ["other generated document id", { documentId: "gendoc-other" }],
    ["generated storage", { document: { ...row().document, storagePath: "generated/legacy.md" } }],
    ["docsgen chunker", { chunkerIdentity: "docsgen:v1:1500" }],
    ["source metadata", { metadata: JSON.stringify({ source: "generated-doc" }) }],
    ["generated id metadata", { metadata: JSON.stringify({ generatedDocumentId: "other" }) }],
    ["empty generated id metadata", { metadata: JSON.stringify({ generatedDocumentId: "" }) }],
  ] satisfies Array<[string, Partial<Row>]>)(
    "excludes %s even if explicitly allowlisted or admin",
    async (_name, changes) => {
      const generated = { ...row(), ...changes };
      expect(
        await filter([generated], {
          sharedDocumentIds: [generated.documentId],
          actor: { userId: "admin", role: "admin" },
        }),
      ).toEqual([]);
    },
  );

  it("admits only explicitly shared non-repository references; allowlisting cannot admit another repository", async () => {
    const shared = {
      ...row(),
      documentId: "reference",
      document: { ...row().document, filename: "glossary.md" },
    };
    expect(await filter([shared])).toHaveLength(1);
    expect(await filter([shared], { sharedDocumentIds: [] })).toEqual([]);
    expect(await filter([row("b")], { sharedDocumentIds: ["doc-b"] })).toEqual([]);
  });

  it.each(["chunk", "document"])(
    "requires current %s ACL even if the other ACL is public",
    async (level) => {
      for (const acl of [
        '[{"kind":"user","value":"bob"}]',
        "broken",
        "null",
        "{}",
        '[{"kind":"unknown","value":"alice"}]',
        '[{"kind":"user","value":"alice"},{}]',
      ]) {
        const restricted = row();
        if (level === "chunk") restricted.aclSubjects = acl;
        else restricted.document.aclSubjects = acl;
        expect(await filter([restricted]), `${level}: ${acl}`).toEqual([]);
      }
    },
  );

  it.each([[{ kind: "user", value: "alice" }], [{ kind: "role", value: "developer" }], []])(
    "allows valid matching ACLs %j on both rows",
    async (...subjects) => {
      const r = row();
      r.aclSubjects = JSON.stringify(subjects);
      r.document.aclSubjects = JSON.stringify(subjects);
      expect(await filter([r])).toHaveLength(1);
    },
  );

  it("allowlisting does not bypass a reference ACL", async () => {
    const r = row();
    r.documentId = "reference";
    r.document.filename = "glossary.md";
    r.document.aclSubjects = '[{"kind":"role","value":"admin"}]';
    expect(await filter([r])).toEqual([]);
  });

  it("propagates SQL failure instead of returning unchecked vector candidates", async () => {
    vi.mocked(prisma.knowledgeChunk.findMany).mockRejectedValue(new Error("SQL unavailable"));
    await expect(filterPrimaryEvidence(candidates([row()]), policy)).rejects.toThrow(
      "SQL unavailable",
    );
  });
});
