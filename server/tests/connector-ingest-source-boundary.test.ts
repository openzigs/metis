/**
 * Issue #288 — source ingest from a filesystem path with symlink-escape
 * confinement (the `local` provider's walk).
 *
 * Proves: ingest-from-path walks real source files inside the directory; a
 * symlink inside the directory pointing OUTSIDE the boundary is NOT followed
 * (its target file is never ingested). Storage + knowledge + prisma are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const created: string[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { filename: string } }) => {
        created.push(data.filename);
        return { id: `doc_${created.length}`, ...data, status: "pending" };
      }),
      update: vi.fn(async () => ({})),
    },
    repoConnection: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: vi.fn(async ({ buffer }: { buffer: Buffer }) => ({
      storagePath: "p",
      checksum: "sha".padEnd(64, "x"),
      sizeBytes: buffer.length,
    })),
  }),
}));
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    ingestDocument: vi.fn(async (id: string) => ({
      status: "ready",
      documentId: id,
      chunkCount: 1,
    })),
  }),
}));

import { ingestSourceAsKnowledge } from "../src/lib/connectors/connector-ingest.js";

let root: string; // realpath'd
let sourceDir: string;
let outsideDir: string;

beforeEach(async () => {
  created.length = 0;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-ingest-src-")));
  sourceDir = path.join(root, "source");
  outsideDir = path.join(root, "outside");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(sourceDir, "b.py"), "b = 2\n");
  await fs.writeFile(path.join(outsideDir, "secret.ts"), "export const secret = 'leak';\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("ingestSourceAsKnowledge (ingest-from-path)", () => {
  it("ingests the source files within the directory", async () => {
    const summary = await ingestSourceAsKnowledge("proj_1", "conn_1", "user_1", sourceDir, {
      boundary: sourceDir,
    });
    expect(summary.documentsCreated).toBe(2);
    expect(created.some((f) => f.endsWith("src/a.ts"))).toBe(true);
    expect(created.some((f) => f.endsWith("src/b.py"))).toBe(true);
  });

  it("does NOT follow a symlink that escapes the boundary (no leak)", async () => {
    // A symlink inside the source dir pointing at an outside directory.
    await fs.symlink(outsideDir, path.join(sourceDir, "escape"));
    const summary = await ingestSourceAsKnowledge("proj_1", "conn_1", "user_1", sourceDir, {
      boundary: sourceDir,
    });
    // Only the two real files inside the dir; the symlinked secret is skipped.
    expect(summary.documentsCreated).toBe(2);
    expect(created.some((f) => f.includes("secret.ts"))).toBe(false);
  });

  it("without a boundary (github clone behaviour) it walks normally", async () => {
    const summary = await ingestSourceAsKnowledge("proj_1", "conn_1", "user_1", sourceDir);
    expect(summary.documentsCreated).toBe(2);
  });

  it("skips macOS __MACOSX / AppleDouble junk during the walk (re-ingest path)", async () => {
    // Simulate an already-extracted macOS zip whose junk was written to disk
    // before the extraction filter existed. The walk must drop the __MACOSX
    // tree and any `._*` / .DS_Store entries so they never re-ingest.
    await fs.mkdir(path.join(sourceDir, "__MACOSX", "sub"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "__MACOSX", "sub", "._a.ts"), "stub");
    await fs.writeFile(path.join(sourceDir, "._a.ts"), "AppleDouble stub");
    await fs.writeFile(path.join(sourceDir, ".DS_Store"), "metadata");
    const summary = await ingestSourceAsKnowledge("proj_1", "conn_1", "user_1", sourceDir);
    // Still only the two REAL source files (a.ts + b.py); no junk ingested.
    expect(summary.documentsCreated).toBe(2);
    expect(created.some((f) => f.includes("__MACOSX"))).toBe(false);
    expect(created.some((f) => f.endsWith("._a.ts"))).toBe(false);
    expect(created.some((f) => f.includes(".DS_Store"))).toBe(false);
  });
});
