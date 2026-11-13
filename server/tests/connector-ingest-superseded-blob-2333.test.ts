/**
 * #2333 — when a sync re-ingests a source file whose stored body changed (a
 * file stored before its secrets were redacted), the blob the document pointed
 * at before is deleted from document storage once the row names the new one,
 * so the unredacted body does not outlive the sync. Blobs are content-addressed
 * and shared, so a blob another live document still names is kept.
 *
 * Real LOCAL document storage (`DocumentStorage` under a temp `UPLOAD_DIR`);
 * prisma and the knowledge service are in-memory fakes.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDoc {
  id: string;
  projectId: string;
  filename: string;
  source: string;
  checksum: string;
  storagePath: string;
  indexState: string;
  chunkCount: number;
  deletedAt: Date | null;
}

const h = vi.hoisted(() => ({
  documents: new Map<string, FakeDoc>(),
  nextId: 0,
}));

vi.mock("../src/lib/logger.js", () => {
  const noop = () => {};
  return { createChildLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }) };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; filename: string } }) => {
        for (const d of h.documents.values()) {
          if (d.projectId === where.projectId && d.filename === where.filename && !d.deletedAt)
            return { ...d };
        }
        return null;
      }),
      findMany: vi.fn(async () =>
        [...h.documents.values()].map((d) => ({ id: d.id, filename: d.filename })),
      ),
      count: vi.fn(
        async ({
          where,
        }: {
          where: { projectId: string; storagePath: string; deletedAt?: null };
        }) =>
          [...h.documents.values()].filter(
            (d) =>
              d.projectId === where.projectId &&
              d.storagePath === where.storagePath &&
              // Honour the filter as given: a count with no `deletedAt` counts every row.
              (!("deletedAt" in where) || d.deletedAt === where.deletedAt),
          ).length,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<FakeDoc, "id" | "indexState" | "chunkCount" | "deletedAt">;
        }) => {
          h.nextId += 1;
          const doc: FakeDoc = {
            ...data,
            id: `doc_${h.nextId}`,
            indexState: "pending",
            chunkCount: 0,
            deletedAt: null,
          };
          h.documents.set(doc.id, doc);
          return doc;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeDoc> }) => {
        const doc = h.documents.get(where.id)!;
        Object.assign(doc, data);
        return doc;
      }),
    },
    repoConnection: { update: vi.fn(async () => ({})) },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    deleteDocument: vi.fn(async (id: string) => h.documents.delete(id)),
    ingestDocument: vi.fn(async (id: string) => {
      Object.assign(h.documents.get(id)!, { indexState: "indexed", chunkCount: 1 });
      return { documentId: id, status: "ready", chunkCount: 1 };
    }),
  }),
}));

import { ingestSourceAsKnowledge } from "../src/lib/connectors/connector-ingest.js";
import { __resetDocumentStorageSingleton, DocumentStorage } from "../src/lib/documents/storage.js";

const k = (...parts: string[]): string => parts.join("");
const GH_TOKEN = k("ghp_", "Zq8".repeat(12));
const CONFIG_TS = `export const token = "${GH_TOKEN}";\nexport const port = 8080;\n`;
const PROJECT = "p1";
const FILENAME = "connector:repo:c1:src/src/config.ts";

let repo: string;
let uploads: string;
let storage: DocumentStorage;
const savedUploadDir = process.env.UPLOAD_DIR;
const savedBackend = process.env.UPLOAD_STORAGE_BACKEND;

/** Store `body` the way main did before #2333, and a live document row naming it. */
async function seedPre2333(id: string, filename: string, body: string): Promise<string> {
  const blob = await storage.write({ projectId: PROJECT, buffer: Buffer.from(body) });
  h.documents.set(id, {
    id,
    projectId: PROJECT,
    filename,
    source: "repo",
    checksum: blob.checksum,
    storagePath: blob.storagePath,
    indexState: "indexed",
    chunkCount: 1,
    deletedAt: null,
  });
  return blob.storagePath;
}

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2333-repo-")));
  uploads = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2333-uploads-")));
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src/config.ts"), CONFIG_TS);
  process.env.UPLOAD_DIR = uploads;
  delete process.env.UPLOAD_STORAGE_BACKEND;
  __resetDocumentStorageSingleton();
  storage = new DocumentStorage({ root: uploads });
  h.documents.clear();
  h.nextId = 0;
});

afterEach(async () => {
  __resetDocumentStorageSingleton();
  if (savedUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = savedUploadDir;
  if (savedBackend !== undefined) process.env.UPLOAD_STORAGE_BACKEND = savedBackend;
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(uploads, { recursive: true, force: true });
});

const oldBody = `# src/config.ts\n\n\`\`\`ts\n${CONFIG_TS}\n\`\`\`\n`;

describe("#2333 — the superseded blob leaves local storage", () => {
  it("deletes the pre-#2333 unredacted blob once the document names the redacted one", async () => {
    const oldPath = await seedPre2333("doc_old", FILENAME, oldBody);
    expect(await storage.exists(oldPath)).toBe(true);

    const summary = await ingestSourceAsKnowledge(PROJECT, "c1", "u1", repo);

    expect(summary.documentsUpdated).toBe(1);
    const doc = h.documents.get("doc_old")!;
    expect(doc.storagePath).not.toBe(oldPath);
    expect(await storage.exists(doc.storagePath)).toBe(true);
    expect((await storage.read(doc.storagePath)).toString()).not.toContain(GH_TOKEN);
    expect(await storage.exists(oldPath)).toBe(false);
  });

  it("keeps the old blob while another live document still names it", async () => {
    const oldPath = await seedPre2333("doc_old", FILENAME, oldBody);
    // Same bytes, so the same content-addressed blob (a user's upload, say).
    await seedPre2333("doc_twin", "upload:config.md", oldBody);

    await ingestSourceAsKnowledge(PROJECT, "c1", "u1", repo);

    expect(h.documents.get("doc_old")!.storagePath).not.toBe(oldPath);
    expect(await storage.exists(oldPath)).toBe(true);
  });

  it("a soft-deleted document is no claim on the blob", async () => {
    const oldPath = await seedPre2333("doc_old", FILENAME, oldBody);
    await seedPre2333("doc_gone", "upload:config.md", oldBody);
    h.documents.get("doc_gone")!.deletedAt = new Date();

    await ingestSourceAsKnowledge(PROJECT, "c1", "u1", repo);

    expect(await storage.exists(oldPath)).toBe(false);
  });

  it("leaves the blob alone when the body did not change", async () => {
    const cleanBody = "# src/config.ts\n\n```ts\nexport const port = 8080;\n\n```\n";
    await fs.writeFile(path.join(repo, "src/config.ts"), "export const port = 8080;\n");
    const path0 = await seedPre2333("doc_clean", FILENAME, cleanBody);

    const summary = await ingestSourceAsKnowledge(PROJECT, "c1", "u1", repo);

    expect(summary.documentsUpdated).toBe(0);
    expect(h.documents.get("doc_clean")!.storagePath).toBe(path0);
    expect(await storage.exists(path0)).toBe(true);
  });
});
