import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import { AIProviderError } from "../ai/errors.js";
import type { StorageBackend } from "../documents/storage.js";
import type { AclActor } from "../rag/acl.js";

interface DocRow {
  id: string;
  projectId: string;
  filename: string;
  title: string | null;
  mimeType: string;
  storagePath: string;
  aclSubjects?: string;
  checksum?: string;
  source?: string;
  uploadedAt?: number;
}

const db = {
  documents: [] as DocRow[],
  knowledge: [] as Array<{ projectId: string; documentId: string; position: number; text: string }>,
  quarantine: [] as Array<{ projectId: string; documentId: string; ord: number; text: string }>,
};

/** Filters on the project, the ids and the excluded sources; newest first when ordered. */
const findManyDocuments = vi.fn(
  async ({
    where,
    orderBy,
  }: {
    where: {
      projectId: string;
      id?: { in: string[] };
      source?: { notIn: string[] };
    };
    orderBy?: unknown;
  }) => {
    const rows = db.documents
      .filter(
        (d) =>
          d.projectId === where.projectId &&
          (!where.id || where.id.in.includes(d.id)) &&
          (!where.source || !where.source.notIn.includes(d.source ?? "upload")),
      )
      .map((d) => ({ ...d, aclSubjects: d.aclSubjects ?? "[]" }));
    return orderBy ? rows.sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0)) : rows;
  },
);

const auditMock = vi.fn();
vi.mock("../audit/audit-service.js", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

vi.mock("../prisma.js", () => ({
  prisma: {
    document: { findMany: (args: never) => findManyDocuments(args) },
    knowledgeChunk: {
      findMany: vi.fn(
        async ({ where }: { where: { projectId: string; documentId: { in: string[] } } }) =>
          db.knowledge.filter(
            (c) => c.projectId === where.projectId && where.documentId.in.includes(c.documentId),
          ),
      ),
    },
    quarantineChunk: {
      findMany: vi.fn(
        async ({ where }: { where: { projectId: string; documentId: { in: string[] } } }) =>
          db.quarantine.filter(
            (c) =>
              c.projectId === where.projectId &&
              where.documentId.in.includes(c.documentId) &&
              c.ord >= 0,
          ),
      ),
    },
  },
}));

const {
  READER_IMPLICIT_MAX_DOCUMENTS,
  chunkIndexer,
  createReaderDocumentLoader,
  implicitReaderSelection,
  readerSourceOf,
  reusedReadingsSentence,
  runDocumentReaderAgent,
} = await import("./document-reader-agent.js");
const { spentUsageOf } = await import("../document-reader/reader.js");

/** A project member with no special role or group. */
const MEMBER: AclActor = { userId: "u1", role: "member" };
const restrictedTo = (...subjects: Array<{ kind: string; value: string }>) =>
  JSON.stringify(subjects);

const TEXT = [
  "# Grants FRD",
  "",
  "## 1 Eligibility",
  "",
  "An applicant must be a registered charity in the county.",
  "",
  "## 2 Payment",
  "",
  "Grants over 5,000 pounds shall be paid in two instalments.",
  "The council expects demand to rise next year.",
  "",
].join("\n");

function storage(files: Record<string, string | Error>): StorageBackend {
  return {
    async read(path: string) {
      const f = files[path];
      if (f === undefined || f instanceof Error) throw f ?? new Error("missing");
      return Buffer.from(f, "utf8");
    },
  } as unknown as StorageBackend;
}

function provider(reply: (system: string) => string): AIProvider {
  return {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    async chat(_messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      return {
        content: reply(opts?.systemMessage ?? ""),
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
      };
    },
  } as unknown as AIProvider;
}

const READ_REPLY = JSON.stringify({
  statements: [
    {
      section: "S2",
      kind: "requirement",
      statement: "Applicants are registered county charities.",
      quote: "An applicant must be a registered charity in the county.",
    },
    {
      section: "S3",
      kind: "business-rule",
      statement: "Large grants are paid in two instalments.",
      quote: "Grants over 5,000 pounds shall be paid in two instalments.",
    },
    // Kept as a statement, but not a requirement.
    {
      section: "S3",
      kind: "assumption",
      statement: "Demand will rise.",
      quote: "The council expects demand to rise next year.",
    },
    {
      section: "S1",
      kind: "definition",
      statement: "A grant is money given.",
      // Not in the document: dropped.
      quote: "A grant means money the council gives away.",
    },
  ],
});
const NO_MERGE = JSON.stringify({ duplicates: [], crossReferences: [] });
const reading = provider((system) =>
  system.includes("combining the statements") ? NO_MERGE : READ_REPLY,
);

beforeEach(() => {
  db.documents = [];
  db.knowledge = [];
  db.quarantine = [];
  findManyDocuments.mockClear();
  auditMock.mockClear();
});

/** The reader's ACL audit rows, by action. */
const aclAudits = () =>
  auditMock.mock.calls
    .map(
      (c) => c[0] as { action: string; actor: { id: string }; target: unknown; metadata: unknown },
    )
    .filter((a) => a.action.startsWith("analysis.document_reader.acl_"));

describe("createReaderDocumentLoader", () => {
  it("loads only this project's ready documents, in selection order, with their stored chunks", async () => {
    db.documents = [
      {
        id: "d2",
        projectId: "p1",
        filename: "b.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/b",
      },
      {
        id: "d1",
        projectId: "p1",
        filename: "a.md",
        title: "Grants FRD",
        mimeType: "text/markdown",
        storagePath: "p1/a",
        checksum: "sum-a",
      },
      {
        id: "d3",
        projectId: "p2",
        filename: "other.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p2/c",
      },
    ];
    db.knowledge = [{ projectId: "p1", documentId: "d1", position: 0, text: "approved chunk" }];
    db.quarantine = [
      { projectId: "p1", documentId: "d2", ord: 0, text: "quarantined chunk" },
      { projectId: "p1", documentId: "d2", ord: -4, text: "" },
    ];
    const load = createReaderDocumentLoader(
      storage({ "p1/a": TEXT, "p1/b": "# B\n\nb", "p2/c": "# other" }),
    );
    const loads = await load("p1", ["d1", "d2", "d3"], MEMBER);

    const where = findManyDocuments.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      projectId: "p1",
      deletedAt: null,
      status: "ready",
      indexState: { not: "rejected" },
    });
    expect(loads.map((l) => (l.ok ? l.document.documentId : `!${l.documentId}`))).toEqual([
      "d1",
      "d2",
      "!d3",
    ]);
    const [a, b] = loads;
    expect(a).toMatchObject({
      ok: true,
      document: {
        title: "Grants FRD",
        text: TEXT,
        chunks: [{ index: 0, text: "approved chunk" }],
        // #2280 — the key its reading is saved under.
        checksum: "sum-a",
      },
    });
    expect(b).toMatchObject({
      ok: true,
      document: { title: "b.md", chunks: [{ index: 0, text: "quarantined chunk" }] },
    });
    expect(loads[2]).toMatchObject({ ok: false, reason: expect.stringContaining("not available") });
  });

  it("reports a file storage cannot read, and one that cannot be converted, with a safe reason", async () => {
    db.documents = [
      {
        id: "d1",
        projectId: "p1",
        filename: "gone.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/gone",
      },
      {
        id: "d2",
        projectId: "p1",
        filename: "fake.pdf",
        title: null,
        mimeType: "application/pdf",
        storagePath: "p1/fake",
      },
    ];
    const load = createReaderDocumentLoader(
      storage({ "p1/gone": new Error("ENOENT /var/secret/path"), "p1/fake": "not a pdf" }),
    );
    const loads = await load("p1", ["d1", "d2"], MEMBER);
    expect(loads).toEqual([
      {
        ok: false,
        documentId: "d1",
        filename: "gone.md",
        reason: "Its stored file could not be read.",
      },
      {
        ok: false,
        documentId: "d2",
        filename: "fake.pdf",
        reason: "Its file could not be converted to text.",
      },
    ]);
  });
});

describe("#2262 — the loader applies the requester's ACL", () => {
  const row = (id: string, aclSubjects: string): DocRow => ({
    id,
    projectId: "p1",
    filename: `${id}-secret-name.md`,
    title: null,
    mimeType: "text/markdown",
    storagePath: `p1/${id}`,
    aclSubjects,
  });

  beforeEach(() => {
    db.documents = [
      row("open", "[]"),
      row("mine", restrictedTo({ kind: "user", value: "u1" })),
      row("theirs", restrictedTo({ kind: "user", value: "u2" })),
      row("analysts", restrictedTo({ kind: "role", value: "analyst" })),
      row("finance", restrictedTo({ kind: "group", value: "finance" })),
    ];
  });
  const files = storage({
    "p1/open": TEXT,
    "p1/mine": TEXT,
    "p1/theirs": TEXT,
    "p1/analysts": TEXT,
    "p1/finance": TEXT,
  });
  const ids = ["open", "mine", "theirs", "analysts", "finance"];
  const readable = async (actor: AclActor) =>
    (await createReaderDocumentLoader(files)("p1", ids, actor)).map((l) =>
      l.ok ? l.document.documentId : null,
    );

  it("withholds a document restricted to someone else, naming neither it nor why", async () => {
    const loads = await createReaderDocumentLoader(files)("p1", ids, MEMBER);
    expect(loads.map((l) => (l.ok ? l.document.documentId : null))).toEqual([
      "open",
      "mine",
      null,
      null,
      null,
    ]);
    const theirs = loads[2]!;
    expect(theirs).toEqual({
      ok: false,
      documentId: "theirs",
      // The id the requester sent, never the stored filename.
      filename: "theirs",
      reason: expect.stringContaining("not available"),
      unavailable: true,
    });
  });

  it("#2297 — reports an id that does not exist exactly as one its ACL withholds", async () => {
    const [theirs, gone] = await createReaderDocumentLoader(files)(
      "p1",
      ["theirs", "nope"],
      MEMBER,
    );
    // Field for field, bar the id the requester sent: no existence oracle.
    expect(gone).toEqual({ ...theirs, documentId: "nope", filename: "nope" });
  });

  it("#2297 — audits the documents the requester's ACL withheld, and not a missing id", async () => {
    await createReaderDocumentLoader(files)("p1", [...ids, "nope"], MEMBER);
    expect(aclAudits()).toEqual([
      {
        actor: { id: "u1" },
        action: "analysis.document_reader.acl_denied",
        target: { type: "project", id: "p1" },
        metadata: {
          reason: "aclMismatch",
          role: "member",
          documentIds: ["theirs", "analysts", "finance"],
        },
      },
    ]);
  });

  it("#2297 — audits an admin's read of a restricted document no subject names them in", async () => {
    db.documents.push(row("admins", restrictedTo({ kind: "role", value: "admin" })));
    await createReaderDocumentLoader(storage({ "p1/admins": TEXT }))("p1", [...ids, "admins"], {
      userId: "u9",
      role: "admin",
    });
    expect(aclAudits()).toEqual([
      {
        actor: { id: "u9" },
        action: "analysis.document_reader.acl_bypass",
        target: { type: "project", id: "p1" },
        metadata: {
          reason: "adminBypass",
          role: "admin",
          // Not "open" (unrestricted), nor "admins" (its ACL names the role).
          documentIds: ["mine", "theirs", "analysts", "finance"],
        },
      },
    ]);
  });

  it("#2297 — writes no ACL audit row when every document is the requester's to read", async () => {
    await createReaderDocumentLoader(files)("p1", ["open", "mine"], MEMBER);
    expect(aclAudits()).toEqual([]);
  });

  it("#2297 — an audit write that throws does not fail the read", async () => {
    auditMock.mockImplementationOnce(() => {
      throw new Error("audit down");
    });
    const loads = await createReaderDocumentLoader(files)("p1", ids, MEMBER);
    expect(loads.filter((l) => l.ok)).toHaveLength(2);
  });

  it("reads a role's, a group's and an admin's documents for them", async () => {
    expect(await readable({ userId: "u9", role: "analyst" })).toEqual([
      "open",
      null,
      null,
      "analysts",
      null,
    ]);
    expect(await readable({ userId: "u9", role: "member", groups: ["finance"] })).toEqual([
      "open",
      null,
      null,
      null,
      "finance",
    ]);
    expect(await readable({ userId: "u9", role: "admin" })).toEqual(ids);
  });
});

describe("#2262 — implicitReaderSelection", () => {
  it("takes the newest visible uploads up to the bound and names the rest", async () => {
    const n = READER_IMPLICIT_MAX_DOCUMENTS + 2;
    db.documents = [
      ...Array.from({ length: n }, (_, i) => ({
        id: `d${i}`,
        projectId: "p1",
        filename: `doc-${i}.md`,
        title: null,
        mimeType: "text/markdown",
        storagePath: `p1/d${i}`,
        uploadedAt: i,
      })),
      {
        id: "secret",
        projectId: "p1",
        filename: "secret.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/secret",
        aclSubjects: restrictedTo({ kind: "user", value: "u2" }),
        uploadedAt: 999,
      },
      {
        id: "repo",
        projectId: "p1",
        filename: "connector:repo:x",
        title: null,
        mimeType: "text/plain",
        storagePath: "p1/repo",
        source: "repo",
        uploadedAt: 1000,
      },
    ];
    const selection = await implicitReaderSelection("p1", MEMBER);

    const query = findManyDocuments.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(query.where).toMatchObject({
      projectId: "p1",
      deletedAt: null,
      status: "ready",
      indexState: { not: "rejected" },
      source: { notIn: ["repo", "db"] },
    });
    expect(query.orderBy).toEqual([{ uploadedAt: "desc" }, { id: "asc" }]);
    // Newest first; the restricted one and the repository row are not candidates.
    expect(selection.documentIds).toEqual(["d6", "d5", "d4", "d3", "d2"]);
    expect(selection.leftOut.map((d) => [d.documentId, d.filename, d.status])).toEqual([
      ["d1", "doc-1.md", "unread"],
      ["d0", "doc-0.md", "unread"],
    ]);
    expect(selection.leftOut[0]!.reason).toContain(
      `reads the ${READER_IMPLICIT_MAX_DOCUMENTS} most recently uploaded`,
    );
    // #2297 — the withheld one is audited, as retrieval audits a denial.
    expect(aclAudits()).toEqual([
      expect.objectContaining({
        action: "analysis.document_reader.acl_denied",
        metadata: expect.objectContaining({ documentIds: ["secret"] }),
      }),
    ]);
  });

  it("#2321 — audits only the withheld documents ranked within the bound: those it would have read", async () => {
    const upload = (id: string, uploadedAt: number, restricted: boolean) => ({
      id,
      projectId: "p1",
      filename: `${id}.md`,
      title: null,
      mimeType: "text/markdown",
      storagePath: `p1/${id}`,
      uploadedAt,
      ...(restricted ? { aclSubjects: restrictedTo({ kind: "user", value: "u2" }) } : {}),
    });
    expect(READER_IMPLICIT_MAX_DOCUMENTS).toBe(5);
    db.documents = [
      // Ranks 0-1 withheld, 2-3 readable, rank 4 (the last within the bound)
      // withheld, rank 5 (the first past it) withheld; then readable ones and
      // forty more withheld. Pins the bound exactly: one less drops `edge-in`,
      // one more adds `edge-out`.
      upload("new-a", 100, true),
      upload("new-b", 99, true),
      upload("v0", 60, false),
      upload("v1", 59, false),
      upload("edge-in", 58, true),
      upload("edge-out", 57, true),
      ...Array.from({ length: 4 }, (_, i) => upload(`v${i + 2}`, 50 - i, false)),
      ...Array.from({ length: 40 }, (_, i) => upload(`old-${i}`, 10 - i, true)),
    ];
    const selection = await implicitReaderSelection("p1", MEMBER);
    expect(selection.documentIds).toEqual(["v0", "v1", "v2", "v3", "v4"]);
    // Read in the newest five's place had the member seen them; the older ones never would be.
    expect(aclAudits()).toEqual([
      expect.objectContaining({
        action: "analysis.document_reader.acl_denied",
        metadata: expect.objectContaining({ documentIds: ["new-a", "new-b", "edge-in"] }),
      }),
    ]);
  });

  it("#2297 — audits an admin's bypass of a restricted document it lists as left out", async () => {
    db.documents = Array.from({ length: READER_IMPLICIT_MAX_DOCUMENTS + 1 }, (_, i) => ({
      id: `d${i}`,
      projectId: "p1",
      filename: `doc-${i}.md`,
      title: null,
      mimeType: "text/markdown",
      storagePath: `p1/d${i}`,
      uploadedAt: i,
      // The oldest, so left out; restricted to someone else.
      ...(i === 0 ? { aclSubjects: restrictedTo({ kind: "user", value: "u2" }) } : {}),
    }));
    const selection = await implicitReaderSelection("p1", { userId: "u9", role: "admin" });
    expect(selection.leftOut.map((d) => d.documentId)).toEqual(["d0"]);
    expect(aclAudits()).toEqual([
      expect.objectContaining({
        action: "analysis.document_reader.acl_bypass",
        metadata: expect.objectContaining({ documentIds: ["d0"] }),
      }),
    ]);
  });
});

describe("chunkIndexer", () => {
  it("maps an offset to the stored chunk covering it, and nothing to text no chunk covers", () => {
    const text = "alpha beta gamma delta";
    const at = chunkIndexer(text, [
      { index: 0, text: "alpha beta" },
      { index: 1, text: "beta gamma" },
      { index: 2, text: "not in the text" },
    ]);
    expect(at(0)).toBe(0);
    expect(at(text.indexOf("gamma"))).toBe(1);
    expect(at(text.indexOf("delta"))).toBeUndefined();
  });
});

describe("#2280 — runDocumentReaderAgent reuses a saved reading", () => {
  type Row = Record<string, unknown>;
  function store() {
    const rows: Row[] = [];
    const same = (r: Row, w: Row) => Object.entries(w).every(([k, v]) => r[k] === v);
    return {
      rows,
      db: {
        savedDocumentReading: {
          findFirst: vi.fn(
            async ({ where }: { where: Row }) => rows.find((r) => same(r, where)) ?? null,
          ),
          upsert: vi.fn(
            async (a: {
              where: { documentId_checksum_readerVersion_model_textHash: Row };
              create: Row;
              update: Row;
            }) => {
              const row = rows.find((r) =>
                same(r, a.where.documentId_checksum_readerVersion_model_textHash),
              );
              if (row) return Object.assign(row, a.update);
              const created = { ...a.create, createdAt: new Date("2026-11-03T10:00:00Z") };
              rows.push(created);
              return created;
            },
          ),
          // #2293 — the save's tidy-up: nothing here is superseded.
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        // #2293 — every document here is live and the run's project's.
        document: { findFirst: vi.fn(async () => ({ id: "live" })) },
      } as never,
    };
  }
  const saved = (documentId: string, checksum: string | null = `sum-${documentId}`) => ({
    ok: true as const,
    document: {
      documentId,
      filename: `${documentId}.docx`,
      title: "Grants FRD",
      text: TEXT,
      chunks: [],
      ...(checksum ? { checksum } : {}),
    },
  });
  function counting() {
    let calls = 0;
    const p = provider((system) => {
      calls++;
      return system.includes("combining the statements") ? NO_MERGE : READ_REPLY;
    });
    return { provider: p, calls: () => calls };
  }
  type Out = {
    summary: string;
    requirements: Array<{ id: string; text: string; source: unknown }>;
  };

  it("reads once; the second run calls no model, finds the same requirements and says it reused the reading", async () => {
    const cache = store();
    const model = counting();
    const run = (reread?: boolean) =>
      runDocumentReaderAgent({
        provider: model.provider,
        projectId: "p1",
        documentIds: ["d1"],
        actor: MEMBER,
        load: async () => [saved("d1")],
        cache,
        ...(reread ? { reread } : {}),
      });
    const first = await run();
    expect(model.calls()).toBe(2);
    expect(cache.rows).toHaveLength(1);
    expect(cache.rows[0]).toMatchObject({ projectId: "p1", documentId: "d1", checksum: "sum-d1" });
    expect(first!.coverage.documents[0]!.reused).toBeUndefined();

    const second = await run();
    expect(model.calls()).toBe(2);
    expect(second!.result.usage.totalTokens).toBe(0);
    const a = first!.result.output as unknown as Out;
    const b = second!.result.output as unknown as Out;
    expect(b.requirements).toEqual(a.requirements);
    expect(second!.coverage.documents[0]).toMatchObject({
      status: "read",
      reused: { readAt: "2026-11-03T10:00:00.000Z", model: "claude-sonnet-5-5" },
    });
    expect(b.summary).toContain(
      'The saved reading of "d1.docx" (read 2026-11-03 with claude-sonnet-5-5) was reused: that document was not read again',
    );

    // "Read the documents again" reads it, and says nothing about a reuse.
    const third = await run(true);
    expect(model.calls()).toBe(4);
    expect(third!.coverage.documents[0]!.reused).toBeUndefined();
    expect((third!.result.output as unknown as Out).summary).not.toContain("reused");
  });

  it("saves nothing for a document loaded without a checksum", async () => {
    const cache = store();
    const model = counting();
    for (let i = 0; i < 2; i++) {
      await runDocumentReaderAgent({
        provider: model.provider,
        projectId: "p1",
        documentIds: ["d1"],
        actor: MEMBER,
        load: async () => [saved("d1", null)],
        cache,
      });
    }
    expect(model.calls()).toBe(4);
    expect(cache.rows).toHaveLength(0);
  });

  it("#2262 — a reading made with other operator notes, or none, is never reused", async () => {
    const cache = store();
    const model = counting();
    const run = (operatorNotes?: string) =>
      runDocumentReaderAgent({
        provider: model.provider,
        projectId: "p1",
        documentIds: ["d1"],
        actor: MEMBER,
        load: async () => [saved("d1")],
        cache,
        ...(operatorNotes ? { operatorNotes } : {}),
      });
    await run("Only the payment rules matter.");
    expect(model.calls()).toBe(2);
    // The same notes reuse it; other notes, and none, read again.
    const same = await run("Only the payment rules matter.");
    expect(model.calls()).toBe(2);
    expect(same!.coverage.documents[0]!.reused).toBeDefined();
    const other = await run("Only eligibility matters.");
    expect(model.calls()).toBe(4);
    expect(other!.coverage.documents[0]!.reused).toBeUndefined();
    const none = await run();
    expect(model.calls()).toBe(6);
    expect(none!.coverage.documents[0]!.reused).toBeUndefined();
    expect(cache.rows).toHaveLength(3);
  });

  it("#2262 — a read through the saved-reading store that fails still counts what it spent", async () => {
    const cache = store();
    const spent = { promptTokens: 70, completionTokens: 40, totalTokens: 110 };
    const failing = new AIProviderError("upstream down", 503);
    const { withSpentUsage } = await import("../document-reader/reader.js");
    const err = await runDocumentReaderAgent({
      provider: counting().provider,
      projectId: "p1",
      documentIds: ["d1"],
      actor: MEMBER,
      load: async () => [saved("d1")],
      cache: {
        ...cache,
        read: async () => {
          throw withSpentUsage(failing, spent);
        },
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(failing);
    expect(spentUsageOf(err)?.totalTokens).toBe(110);
    expect(cache.rows).toHaveLength(0);
  });
});

describe("reusedReadingsSentence", () => {
  const at = new Date("2026-11-03T10:00:00Z");
  it("is empty when nothing was reused", () => {
    expect(reusedReadingsSentence([])).toBe("");
  });
  it("names up to three documents, then how many more", () => {
    const many = ["a", "b", "c", "d", "e"].map((f) => ({
      filename: `${f}.md`,
      readAt: at,
      model: "m",
    }));
    const s = reusedReadingsSentence(many);
    expect(s).toContain('"a.md" (read 2026-11-03 with m), "b.md" (read 2026-11-03 with m), "c.md"');
    expect(s).toContain(
      "and 2 more was reused: those documents were not read again, as their files have not changed.",
    );
    expect(s).not.toContain("d.md");
  });
});

describe("runDocumentReaderAgent", () => {
  const doc = (documentId: string, text = TEXT) => ({
    ok: true as const,
    document: {
      documentId,
      filename: `${documentId}.docx`,
      title: "Grants FRD",
      text,
      chunks: [
        { index: 0, text: text.slice(0, text.indexOf("## 2")) },
        { index: 1, text: text.slice(text.indexOf("## 2")) },
      ],
    },
  });

  it("turns requirement, constraint and business-rule statements into the document agent's requirements and findings", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1", "d2"],
      load: async () => [doc("d1"), doc("d2")],
    });
    const output = read!.result.output as unknown as {
      requirements: Array<{ id: string; text: string; source: unknown }>;
      findings: Array<{
        title: string;
        body: string;
        requirementId: string;
        tags: string[];
        citations: unknown[];
      }>;
      summary: string;
    };
    // Numbering runs on across documents.
    expect(output.requirements.map((r) => [r.id, r.source])).toEqual([
      ["REQ-001", expect.objectContaining({ documentId: "d1", chunkIndex: 0 })],
      ["REQ-002", expect.objectContaining({ documentId: "d1", chunkIndex: 1 })],
      ["REQ-003", expect.objectContaining({ documentId: "d2", chunkIndex: 0 })],
      ["REQ-004", expect.objectContaining({ documentId: "d2", chunkIndex: 1 })],
    ]);
    // #2235 — the verified paragraph travels with the requirement, so its
    // clarifying questions can quote and cite it.
    expect(output.requirements[1]!.source).toEqual({
      documentId: "d1",
      chunkIndex: 1,
      filename: "d1.docx",
      headingPath: ["Grants FRD", "2 Payment"],
      quote: "Grants over 5,000 pounds shall be paid in two instalments.",
    });
    expect(output.findings[1]).toMatchObject({
      title: "Business rule: Large grants are paid in two instalments.",
      requirementId: "REQ-002",
      tags: ["document-reader", "business-rule"],
      citations: [
        {
          documentId: "d1",
          chunkIndex: 1,
          filename: "d1.docx",
          snippet: "Grants over 5,000 pounds shall be paid in two instalments.",
        },
      ],
    });
    expect(output.findings[1]!.body).toContain("Source: d1.docx › Grants FRD › 2 Payment");
    expect(output.summary).toContain("Read 2 of 2 selected documents in full");
    expect(read!.coverage.documents[0]).toMatchObject({
      status: "read",
      statements: 3,
      requirements: 2,
      droppedUnverified: 1,
      merge: "done",
    });
    // Two documents × (one read + one merge), each 55 tokens.
    expect(read!.result.usage.totalTokens).toBe(220);
  });

  it("#2361 — names the section a dropped overview's content was merged into", async () => {
    const merged = provider((system) =>
      system.includes("combining the statements")
        ? JSON.stringify({ duplicates: [{ id: "T1", of: "T2" }], crossReferences: [] })
        : READ_REPLY,
    );
    const read = await runDocumentReaderAgent({
      provider: merged,
      projectId: "p1",
      documentIds: ["d1"],
      actor: MEMBER,
      load: async () => [doc("d1")],
    });
    expect(read!.coverage.documents[0]!.sections).toEqual([
      { heading: "Grants FRD", status: "read", statements: 0, kinds: {} },
      {
        heading: "Grants FRD › 1 Eligibility",
        status: "read",
        statements: 0,
        kinds: {},
        mergedInto: ["Grants FRD › 2 Payment"],
      },
      {
        heading: "Grants FRD › 2 Payment",
        status: "read",
        statements: 2,
        kinds: { "business-rule": 1, assumption: 1 },
      },
    ]);
  });

  it("#2275 — clips a long filename to the source schema's 512 characters", async () => {
    const long = "f".repeat(700);
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      documentIds: ["d1"],
      actor: MEMBER,
      load: async () => [{ ...doc("d1"), document: { ...doc("d1").document, filename: long } }],
    });
    const output = read!.result.output as unknown as {
      requirements: Array<{ source: { filename: string } }>;
    };
    expect(output.requirements[0]!.source.filename.length).toBeLessThanOrEqual(512);
    expect(output.requirements[0]!.source.filename.startsWith("fff")).toBe(true);
  });

  it("cites a statement by its quote alone when no stored chunk covers it", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1"],
      load: async () => [{ ...doc("d1"), document: { ...doc("d1").document, chunks: [] } }],
    });
    const output = read!.result.output as unknown as {
      requirements: Array<{ source: unknown }>;
      findings: Array<{ citations: unknown[]; body: string }>;
    };
    expect(output.requirements[0]!.source).toEqual({
      documentId: "d1",
      filename: "d1.docx",
      headingPath: expect.any(Array),
      quote: "An applicant must be a registered charity in the county.",
    });
    expect(output.findings[0]!.citations).toEqual([]);
    expect(output.findings[0]!.body).toContain(
      "> An applicant must be a registered charity in the county.",
    );
  });

  it("returns null when no selected document's file could be loaded", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1"],
      load: async () => [
        {
          ok: false,
          documentId: "d1",
          filename: "d1.docx",
          reason: "Its stored file could not be read.",
        },
      ],
    });
    expect(read).toBeNull();
  });

  it("#2297 — a missing id and a withheld one give the requester the same result", async () => {
    db.documents = [
      {
        id: "secret",
        projectId: "p1",
        filename: "secret.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/secret",
        aclSubjects: restrictedTo({ kind: "user", value: "u2" }),
      },
    ];
    const run = (id: string) =>
      runDocumentReaderAgent({
        provider: reading,
        projectId: "p1",
        actor: MEMBER,
        documentIds: [id],
        load: createReaderDocumentLoader(storage({ "p1/secret": TEXT })),
      });
    const withheld = await run("secret");
    const missing = await run("nope");
    // Neither falls back to retrieval (null), and the two differ only in the id.
    expect(withheld).not.toBeNull();
    expect(missing).not.toBeNull();
    const shape = (r: typeof withheld) =>
      JSON.parse(
        JSON.stringify({ ...r!.result.output, ...r!.coverage }).replaceAll(/secret|nope/g, "ID"),
      );
    expect(shape(missing)).toEqual(shape(withheld));
    expect(withheld!.coverage.documents).toEqual([
      expect.objectContaining({ documentId: "secret", filename: "secret", status: "unread" }),
    ]);
  });

  it("lists a document no reply could be read for as unread, and reads the others", async () => {
    let n = 0;
    const flaky = provider((system) => {
      if (system.includes("combining the statements")) return NO_MERGE;
      return n++ < 2 ? "garbage" : READ_REPLY;
    });
    const read = await runDocumentReaderAgent({
      provider: flaky,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1", "d2"],
      load: async () => [doc("d1"), doc("d2")],
    });
    expect(read!.coverage.documents.map((d) => [d.documentId, d.status])).toEqual([
      ["d1", "unread"],
      ["d2", "read"],
    ]);
    expect(read!.coverage.documents[0]!.reason).toContain("could not be read");
    expect(read!.result.output.summary).toContain("1 could not be read");
  });

  it("fails when every loaded document's replies were unreadable", async () => {
    await expect(
      runDocumentReaderAgent({
        provider: provider(() => "garbage"),
        projectId: "p1",
        actor: MEMBER,
        documentIds: ["d1"],
        load: async () => [doc("d1")],
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it("fails on a provider error, as the agent call it replaces did", async () => {
    const down = {
      key: "anthropic",
      model: "claude-sonnet-5-5",
      offline: false,
      async chat(): Promise<ChatResponse> {
        throw new AIProviderError("upstream down", 503);
      },
    } as unknown as AIProvider;
    await expect(
      runDocumentReaderAgent({
        provider: down,
        projectId: "p1",
        actor: MEMBER,
        documentIds: ["d1"],
        load: async () => [doc("d1")],
      }),
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  it("#2262 — a provider error on the second document fails the agent, carrying the first one's tokens", async () => {
    let calls = 0;
    const second = {
      key: "anthropic",
      model: "claude-sonnet-5-5",
      offline: false,
      async chat(_m: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
        // d1: one read + one merge; d2's read fails.
        if (++calls > 2) throw new AIProviderError("upstream down", 503);
        return {
          content: (opts?.systemMessage ?? "").includes("combining the statements")
            ? NO_MERGE
            : READ_REPLY,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
        };
      },
    } as unknown as AIProvider;
    const err = await runDocumentReaderAgent({
      provider: second,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1", "d2"],
      load: async () => [doc("d1"), doc("d2")],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(spentUsageOf(err)?.totalTokens).toBe(110);
  });

  it("#2262 — counts the tokens an unreadable document cost, beside the documents read", async () => {
    let n = 0;
    const flaky = provider((system) => {
      if (system.includes("combining the statements")) return NO_MERGE;
      return n++ < 2 ? "garbage" : READ_REPLY;
    });
    const read = await runDocumentReaderAgent({
      provider: flaky,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1", "d2"],
      load: async () => [doc("d1"), doc("d2")],
    });
    // d1: two unreadable attempts; d2: one read + one merge. 55 tokens each.
    expect(read!.result.usage.totalTokens).toBe(220);
  });

  it("#2262 — the error when every document was unreadable carries what they cost", async () => {
    const err = await runDocumentReaderAgent({
      provider: provider(() => "garbage"),
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1", "d2"],
      load: async () => [doc("d1"), doc("d2")],
    }).catch((e) => e);
    expect(err.message).toMatch(/could not be read/);
    // Two documents × two attempts × 55 tokens.
    expect(spentUsageOf(err)?.totalTokens).toBe(220);
  });

  it("#2262 — passes the actor to the loader and the operator's notes to every reading call", async () => {
    const seen: string[] = [];
    const noting = {
      ...reading,
      async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
        if (!(opts?.systemMessage ?? "").includes("combining the statements")) {
          seen.push(messages.map((m) => m.content as string).join("\n"));
        }
        return reading.chat(messages, opts);
      },
    } as unknown as AIProvider;
    const load = vi.fn(async () => [doc("d1"), doc("d2")]);
    await runDocumentReaderAgent({
      provider: noting,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1", "d2"],
      operatorNotes: "Only the payment rules matter for this change.",
      load,
    });
    expect(load).toHaveBeenCalledWith("p1", ["d1", "d2"], MEMBER);
    expect(seen).toHaveLength(2);
    for (const prompt of seen) {
      expect(prompt).toContain("Only the payment rules matter for this change.");
    }
  });

  it("#2262 — says how many statements it found to analyse", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1"],
      load: async () => [doc("d1")],
    });
    expect(read!.result.output.summary).toBe(
      "Read 1 of 1 selected document in full (3 sections): 2 statements to analyse, each with its source.",
    );
    const one = await runDocumentReaderAgent({
      provider: provider((system) =>
        system.includes("combining the statements")
          ? NO_MERGE
          : JSON.stringify({ statements: [JSON.parse(READ_REPLY).statements[0]] }),
      ),
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["d1"],
      load: async () => [doc("d1")],
    });
    expect(one!.result.output.summary).toContain(": 1 statement to analyse,");
  });

  it("#2262 — with nothing selected, reads the bounded implicit selection and lists the rest", async () => {
    db.documents = Array.from({ length: READER_IMPLICIT_MAX_DOCUMENTS + 1 }, (_, i) => ({
      id: `d${i}`,
      projectId: "p1",
      filename: `d${i}.docx`,
      title: null,
      mimeType: "text/markdown",
      storagePath: `p1/d${i}`,
      uploadedAt: i,
    }));
    const load = vi.fn(async (_p: string, ids: readonly string[]) => ids.map((id) => doc(id)));
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: [],
      load,
    });
    expect(load).toHaveBeenCalledWith("p1", ["d5", "d4", "d3", "d2", "d1"], MEMBER);
    expect(read!.coverage.documents.map((d) => [d.documentId, d.status])).toEqual([
      ["d5", "read"],
      ["d4", "read"],
      ["d3", "read"],
      ["d2", "read"],
      ["d1", "read"],
      ["d0", "unread"],
    ]);
    expect(read!.result.output.summary).toContain("Read 5 of 6 uploaded documents");
    // #2297 — left out on purpose, not "could not be read".
    expect(read!.result.output.summary).not.toContain("could not be read");
    expect(read!.result.output.summary).toContain(
      `1 was left out: with no document selected, only the ${READER_IMPLICIT_MAX_DOCUMENTS} most recently uploaded are read.`,
    );
  });

  it("#2321 — with nothing selected, no upload at all reads exactly as every upload withheld", async () => {
    const run = async () => {
      const load = vi.fn(async () => []);
      const read = await runDocumentReaderAgent({
        provider: reading,
        projectId: "p1",
        actor: MEMBER,
        documentIds: [],
        load,
      });
      expect(load).not.toHaveBeenCalled();
      return read;
    };
    db.documents = [];
    const none = await run();
    db.documents = [
      {
        id: "secret",
        projectId: "p1",
        filename: "secret.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/secret",
        aclSubjects: restrictedTo({ kind: "user", value: "u2" }),
      },
    ];
    const withheld = await run();
    // Neither sends the caller to retrieval (null), and the requester sees the same in both.
    expect(none).not.toBeNull();
    const shape = (r: typeof none) =>
      JSON.parse(JSON.stringify({ ...r!.result.output, ...r!.coverage }));
    expect(shape(withheld)).toEqual(shape(none));
    expect(none!.coverage.documents).toEqual([]);
    expect(none!.result.output.summary).toBe(
      "No document was read: none was selected, and no ready uploaded document was found to read.",
    );
  });

  it("#2321 — with nothing selected, an upload that cannot be loaded is listed, not retrieved instead", async () => {
    db.documents = [
      {
        id: "d1",
        projectId: "p1",
        filename: "d1.docx",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/d1",
      },
    ];
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: [],
      load: async () => [
        {
          ok: false,
          documentId: "d1",
          filename: "d1.docx",
          reason: "Its stored file could not be read.",
        },
      ],
    });
    expect(read).not.toBeNull();
    expect(read!.coverage.documents).toEqual([
      expect.objectContaining({ documentId: "d1", status: "unread" }),
    ]);
    // #2321 review — none was selected, so the summary does not say "selected".
    expect(read!.result.output.summary).toBe(
      "Read 0 of 1 uploaded document in full (0 sections): 0 statements to analyse, each with its source. " +
        "1 could not be read; the coverage report says why.",
    );
  });

  it("#2262 — never sends the caller to retrieval for a document its ACL withheld", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: ["secret"],
      load: async () => [
        {
          ok: false,
          documentId: "secret",
          filename: "secret",
          reason: "unavailable",
          unavailable: true,
        },
      ],
    });
    expect(read).not.toBeNull();
    expect(read!.result.output.findings).toEqual([]);
    expect(read!.coverage.documents).toEqual([
      expect.objectContaining({ documentId: "secret", status: "unread" }),
    ]);
  });

  it("#2262 — nor when the implicit selection held only documents the requester may not see", async () => {
    db.documents = [
      {
        id: "secret",
        projectId: "p1",
        filename: "secret.md",
        title: null,
        mimeType: "text/markdown",
        storagePath: "p1/secret",
        aclSubjects: restrictedTo({ kind: "user", value: "u2" }),
      },
    ];
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      actor: MEMBER,
      documentIds: [],
      load: async () => [],
    });
    expect(read).not.toBeNull();
    // The withheld document is not named to the requester.
    expect(read!.coverage.documents).toEqual([]);
  });
});

describe("readerSourceOf (#2235)", () => {
  it("reads the verified paragraph off a stored requirement, labelled with its id", () => {
    expect(
      readerSourceOf("REQ-002", {
        documentId: "d1",
        chunkIndex: 1,
        filename: "d1.docx",
        headingPath: ["Grants FRD", 7, "2 Payment"],
        quote: "Paid in two instalments.",
      }),
    ).toEqual({
      ref: "REQ-002",
      documentId: "d1",
      filename: "d1.docx",
      headingPath: ["Grants FRD", "2 Payment"],
      quote: "Paid in two instalments.",
    });
  });

  it("reads nothing from a requirement with no quote (the retrieval path, or output from before #2235)", () => {
    expect(readerSourceOf("REQ-001", { documentId: "d1", chunkIndex: 0 })).toBeUndefined();
    expect(readerSourceOf("REQ-001", { quote: "   " })).toBeUndefined();
    expect(readerSourceOf("REQ-001", undefined)).toBeUndefined();
    expect(readerSourceOf("REQ-001", "d1")).toBeUndefined();
    expect(readerSourceOf("REQ-001", { quote: "Q", headingPath: "x" })).toEqual({
      ref: "REQ-001",
      headingPath: [],
      quote: "Q",
    });
  });
});
