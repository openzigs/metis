import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import { AIProviderError } from "../ai/errors.js";
import type { StorageBackend } from "../documents/storage.js";

const db = {
  documents: [] as Array<{
    id: string;
    projectId: string;
    filename: string;
    title: string | null;
    mimeType: string;
    storagePath: string;
    checksum?: string;
  }>,
  knowledge: [] as Array<{ projectId: string; documentId: string; position: number; text: string }>,
  quarantine: [] as Array<{ projectId: string; documentId: string; ord: number; text: string }>,
};

const findManyDocuments = vi.fn(
  async ({ where }: { where: { projectId: string; id: { in: string[] } } }) =>
    db.documents.filter((d) => d.projectId === where.projectId && where.id.in.includes(d.id)),
);

vi.mock("../prisma.js", () => ({
  prisma: {
    document: { findMany: (args: never) => findManyDocuments(args) },
    knowledgeChunk: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; documentId: string } }) =>
        db.knowledge.filter(
          (c) => c.projectId === where.projectId && c.documentId === where.documentId,
        ),
      ),
    },
    quarantineChunk: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; documentId: string } }) =>
        db.quarantine.filter(
          (c) => c.projectId === where.projectId && c.documentId === where.documentId && c.ord >= 0,
        ),
      ),
    },
  },
}));

const {
  chunkIndexer,
  createReaderDocumentLoader,
  readerSourceOf,
  reusedReadingsSentence,
  runDocumentReaderAgent,
} = await import("./document-reader-agent.js");

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
});

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
    const loads = await load("p1", ["d1", "d2", "d3"]);

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
    expect(loads[2]).toMatchObject({ ok: false, reason: expect.stringContaining("not ready") });
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
    const loads = await load("p1", ["d1", "d2"]);
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
        load: async () => [saved("d1", null)],
        cache,
      });
    }
    expect(model.calls()).toBe(4);
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

  it("cites a statement by its quote alone when no stored chunk covers it", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
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

  it("returns null when no selected document could be loaded", async () => {
    const read = await runDocumentReaderAgent({
      provider: reading,
      projectId: "p1",
      documentIds: ["d1"],
      load: async () => [{ ok: false, documentId: "d1", filename: "d1", reason: "gone" }],
    });
    expect(read).toBeNull();
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
        documentIds: ["d1"],
        load: async () => [doc("d1")],
      }),
    ).rejects.toBeInstanceOf(AIProviderError);
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
