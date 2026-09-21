/**
 * Connector → RAG ingestion bridge.
 *
 * Everything is mocked: storage, knowledge service, prisma. We assert that
 * the ingest helpers convert metadata/snapshot to ingestion units, write
 * them via DocumentStorage, create/update Document rows, and call
 * KnowledgeService.ingestDocument for each one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const documents = new Map<
  string,
  { id: string; projectId: string; filename: string; storagePath: string; status: string }
>();
let nextDocId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; filename: string } }) => {
        for (const d of documents.values()) {
          if (d.projectId === where.projectId && d.filename === where.filename) return d;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: { projectId: string; filename: string } }) => {
        nextDocId += 1;
        const doc = {
          id: `doc_${nextDocId}`,
          projectId: data.projectId,
          filename: data.filename,
          storagePath: "p",
          status: "pending",
        };
        documents.set(doc.id, doc);
        return doc;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<{ status: string }> }) => {
          const d = documents.get(where.id);
          if (!d) throw new Error("not found");
          const next = { ...d, ...data };
          documents.set(where.id, next);
          return next;
        },
      ),
    },
    repoConnection: {
      update: vi.fn(async ({ data }: { data: Partial<{ lastIngestAt: Date }> }) => ({
        id: "x",
        ...data,
      })),
    },
    databaseConnection: {
      update: vi.fn(async ({ data }: { data: Partial<{ lastIngestAt: Date }> }) => ({
        id: "x",
        ...data,
      })),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const writeMock = vi.fn(async ({ buffer }: { projectId: string; buffer: Buffer }) => ({
  storagePath: `path/${buffer.length}`,
  checksum: "sha".padEnd(64, "x"),
  sizeBytes: buffer.length,
  absolutePath: "/abs",
  deduplicated: false,
}));

vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({ write: writeMock }),
}));

const ingestDocumentMock = vi.fn(async (id: string) => ({
  status: "ready" as const,
  documentId: id,
  chunkCount: 3,
}));

vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ ingestDocument: ingestDocumentMock }),
}));

import {
  dbSnapshotToUnits,
  ingestDbSchema,
  ingestRepoMetadata,
  repoMetadataToUnits,
  SOURCE_EXTENSIONS,
} from "../src/lib/connectors/connector-ingest.js";

beforeEach(() => {
  documents.clear();
  nextDocId = 0;
  writeMock.mockClear();
  ingestDocumentMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("SOURCE_EXTENSIONS allowlist (#205)", () => {
  it("includes .sas so SAS source is ingested into the RAG index", () => {
    expect(SOURCE_EXTENSIONS.has(".sas")).toBe(true);
  });

  it("retains the existing source extensions", () => {
    for (const ext of [".ts", ".js", ".py", ".go", ".java", ".sql"]) {
      expect(SOURCE_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

describe("repoMetadataToUnits", () => {
  it("emits OVERVIEW + README + manifest units with redaction", () => {
    const units = repoMetadataToUnits("conn_1", {
      repo: { full_name: "o/r", default_branch: "main", size: 10 },
      languages: { TypeScript: 100 },
      topLevel: [{ type: "file", name: "package.json", path: "package.json", size: 50 }],
      readme: "Contact alice@example.com for help",
      manifests: { "package.json": '{"name":"x"}' },
      headSha: "abc",
    });
    expect(units.length).toBeGreaterThanOrEqual(3);
    const readme = units.find((u) => u.filename.endsWith("README.md"));
    expect(readme?.body).toContain("[REDACTED:email]");
    const overview = units.find((u) => u.filename.endsWith("OVERVIEW.md"));
    expect(overview?.body).toContain("o/r");
    const pkg = units.find((u) => u.filename.endsWith("package.json"));
    expect(pkg?.body).toContain('"name"');
  });
});

describe("dbSnapshotToUnits", () => {
  it("emits OVERVIEW + per-table markdown", () => {
    const units = dbSnapshotToUnits("conn_db", {
      connectorId: "conn_db",
      driver: "postgres",
      schema: "public",
      tables: [
        {
          schema: "public",
          name: "users",
          columns: [
            {
              name: "id",
              dataType: "int",
              nullable: false,
              isPrimaryKey: true,
              isForeignKey: false,
            },
            {
              name: "email",
              dataType: "text",
              nullable: false,
              isPrimaryKey: false,
              isForeignKey: false,
            },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
          indexes: [{ name: "users_pk", columns: ["id"], isUnique: true }],
        },
      ],
      extractedAt: new Date().toISOString(),
      durationMs: 12,
    });
    expect(units.length).toBe(2);
    expect(units[1].body).toContain("public.users");
    expect(units[1].body).toContain("Primary Key");
    expect(units[1].body).toContain("Indexes");
  });

  it("stays UNCAPPED — emits a unit for EVERY table even far beyond the docs-gen budget (#890 regression)", () => {
    const tables = Array.from({ length: 400 }, (_, i) => ({
      schema: "public",
      name: `t_${i}`,
      columns: [
        {
          name: "id",
          dataType: "int",
          nullable: false,
          isPrimaryKey: true,
          isForeignKey: false,
        },
      ],
      foreignKeys: [],
      indexes: [],
    }));
    const units = dbSnapshotToUnits("conn_db", {
      connectorId: "conn_db",
      driver: "postgres",
      schema: "public",
      tables,
      extractedAt: new Date().toISOString(),
      durationMs: 99,
    });
    // OVERVIEW + one per table — no truncation regardless of table count
    expect(units.length).toBe(401);
    expect(units.some((u) => u.filename.endsWith("public.t_0.md"))).toBe(true);
    expect(units.some((u) => u.filename.endsWith("public.t_399.md"))).toBe(true);
  });
});

describe("ingestRepoMetadata", () => {
  it("writes documents + invokes knowledge.ingestDocument and updates connector", async () => {
    const summary = await ingestRepoMetadata("proj_1", "conn_repo_1", "user_1", {
      repo: { full_name: "o/r", default_branch: "main", size: 10 },
      languages: { TypeScript: 100 },
      topLevel: [],
      readme: "hi",
      manifests: {},
      headSha: null,
    });
    expect(summary.documentsCreated).toBeGreaterThanOrEqual(2);
    expect(summary.chunkCount).toBeGreaterThan(0);
    expect(writeMock).toHaveBeenCalled();
    expect(ingestDocumentMock).toHaveBeenCalled();
  });
});

describe("ingestDbSchema", () => {
  it("writes per-table documents and aggregates chunk counts", async () => {
    const summary = await ingestDbSchema("proj_1", "conn_db_1", "user_1", {
      connectorId: "conn_db_1",
      driver: "postgres",
      schema: "public",
      tables: [
        {
          schema: "public",
          name: "t1",
          columns: [],
          foreignKeys: [],
          indexes: [],
        },
      ],
      extractedAt: new Date().toISOString(),
      durationMs: 1,
    });
    expect(summary.documentsCreated).toBe(2);
    expect(summary.chunkCount).toBe(6);
  });

  it("requires non-empty projectId", async () => {
    await expect(
      ingestDbSchema("", "conn_x", "user", {
        connectorId: "conn_x",
        driver: "postgres",
        schema: "public",
        tables: [],
        extractedAt: new Date().toISOString(),
        durationMs: 0,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
  });

  it("counts failures when knowledge.ingestDocument returns failed", async () => {
    ingestDocumentMock.mockImplementationOnce(async (id: string) => ({
      status: "failed" as const,
      documentId: id,
      chunkCount: 0,
      errorMessage: "embed error",
    }));
    const summary = await ingestDbSchema("proj_1", "conn_fail", "user_1", {
      connectorId: "conn_fail",
      driver: "postgres",
      schema: "public",
      tables: [{ schema: "public", name: "t", columns: [], foreignKeys: [], indexes: [] }],
      extractedAt: new Date().toISOString(),
      durationMs: 1,
    });
    expect(summary.failures).toBeGreaterThanOrEqual(1);
  });

  it("counts failures when storage.write throws and continues to next unit", async () => {
    writeMock.mockRejectedValueOnce(new Error("disk full"));
    const summary = await ingestDbSchema("proj_1", "conn_disk", "user_1", {
      connectorId: "conn_disk",
      driver: "postgres",
      schema: "public",
      tables: [
        { schema: "public", name: "t1", columns: [], foreignKeys: [], indexes: [] },
        { schema: "public", name: "t2", columns: [], foreignKeys: [], indexes: [] },
      ],
      extractedAt: new Date().toISOString(),
      durationMs: 1,
    });
    expect(summary.failures).toBeGreaterThanOrEqual(1);
    // The remaining units still attempt ingestion.
    expect(writeMock).toHaveBeenCalled();
  });

  it("updates an existing document when filename matches", async () => {
    // Pre-seed a document with the OVERVIEW filename.
    documents.set("doc_pre", {
      id: "doc_pre",
      projectId: "proj_pre",
      filename: "connector:db:conn_pre:OVERVIEW.md",
      storagePath: "old",
      status: "ready",
    });
    const summary = await ingestDbSchema("proj_pre", "conn_pre", "user_1", {
      connectorId: "conn_pre",
      driver: "postgres",
      schema: "public",
      tables: [],
      extractedAt: new Date().toISOString(),
      durationMs: 1,
    });
    expect(summary.documentsUpdated).toBeGreaterThanOrEqual(1);
  });
});
