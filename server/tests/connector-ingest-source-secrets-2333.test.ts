/**
 * #2333 — repository source files are redacted for SECRETS (not PII) before
 * they become a knowledge document, so neither the stored body (what the
 * knowledge service chunks and embeds) nor anything derived from it carries the
 * secret; the log says how many, never what; and a file indexed before #2333 is
 * re-embedded on the next sync rather than skipped as unchanged.
 *
 * Real files on disk; storage, the knowledge service and prisma are in-memory
 * fakes. The body asserted on is the one the knowledge service READS back from
 * storage by the document's storage path — the path a real ingest takes.
 */
import { createHash } from "node:crypto";
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
  deletedAt: null;
}

const h = vi.hoisted(() => ({
  documents: new Map<string, FakeDoc>(),
  blobs: new Map<string, string>(),
  /** What `ingestDocument` read from storage, per filename: the chunker's input. */
  embedded: new Map<string, string>(),
  logs: [] as Array<{ level: string; msg: string; meta: Record<string, unknown> }>,
  nextId: 0,
}));

vi.mock("../src/lib/logger.js", () => {
  const at =
    (level: string) =>
    (msg: string, meta: Record<string, unknown> = {}) =>
      h.logs.push({ level, msg, meta });
  return {
    createChildLogger: () => ({
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      debug: at("debug"),
    }),
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; filename: string } }) => {
        for (const d of h.documents.values()) {
          if (d.projectId === where.projectId && d.filename === where.filename) return { ...d };
        }
        return null;
      }),
      findMany: vi.fn(async () =>
        [...h.documents.values()].map((d) => ({ id: d.id, filename: d.filename })),
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

vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: vi.fn(async ({ buffer }: { buffer: Buffer }) => {
      const checksum = createHash("sha256").update(buffer).digest("hex");
      h.blobs.set(`blob/${checksum}`, buffer.toString("utf-8"));
      return { storagePath: `blob/${checksum}`, checksum, sizeBytes: buffer.length };
    }),
  }),
}));

vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    deleteDocument: vi.fn(async (id: string) => h.documents.delete(id)),
    ingestDocument: vi.fn(async (id: string) => {
      const doc = h.documents.get(id)!;
      // What a real ingest chunks and embeds: the blob at the document's path.
      h.embedded.set(doc.filename, h.blobs.get(doc.storagePath)!);
      Object.assign(doc, { indexState: "indexed", chunkCount: 1 });
      return { documentId: id, status: "ready", chunkCount: 1 };
    }),
  }),
}));

import { ingestSourceAsKnowledge } from "../src/lib/connectors/connector-ingest.js";

const k = (...parts: string[]): string => parts.join("");
const GH_TOKEN = k("ghp_", "Zq8".repeat(12));
const PEM = [
  k("-----BEGIN ", "PRIVATE KEY-----"),
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7MIIEvQIBADANBg",
  "kqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
  k("-----END ", "PRIVATE KEY-----"),
].join("\n");

const CONFIG_TS = [
  "export const config = {",
  `  token: "${GH_TOKEN}",`,
  "  // contact: alice@example.com, 555-123-4567",
  `  key: \`${PEM}\`,`,
  "};",
  "export function port(): number {",
  "  return 8080;",
  "}",
].join("\n");

const CLEAN_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

let root: string;
const DOC = (rel: string) => `connector:repo:c1:src/${rel}`;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2333-")));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/config.ts"), CONFIG_TS);
  await fs.writeFile(path.join(root, "src/clean.ts"), CLEAN_TS);
  h.documents.clear();
  h.blobs.clear();
  h.embedded.clear();
  h.logs.length = 0;
  h.nextId = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("#2333 — secrets out of repository source before ingest", () => {
  it("neither the stored body nor the embedding input carries the secret", async () => {
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    const embedded = h.embedded.get(DOC("src/config.ts"))!;
    expect(embedded).toBeDefined();
    expect(embedded).not.toContain(GH_TOKEN);
    expect(embedded).not.toContain("MIIEvQIBADANBgkq");
    expect(embedded).toContain('token: "[REDACTED:github_pat]",');
    expect(embedded).toContain("[REDACTED:private_key]");
    // Every stored blob, not only the one this document points at.
    for (const body of h.blobs.values()) expect(body).not.toContain(GH_TOKEN);
  });

  it("applies the secret set only: PII in source code is left as it is", async () => {
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    expect(h.embedded.get(DOC("src/config.ts"))).toContain(
      "// contact: alice@example.com, 555-123-4567",
    );
  });

  it("keeps every line of the file at its number", async () => {
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    const body = h.embedded.get(DOC("src/config.ts"))!;
    // The body is `# path`, a blank line and the fence, then the file.
    const fileLines = body.split("\n").slice(3, 3 + CONFIG_TS.split("\n").length);
    const before = CONFIG_TS.split("\n");
    expect(fileLines).toHaveLength(before.length);
    for (const [i, line] of before.entries()) {
      if (!fileLines[i].includes("[REDACTED:")) expect(fileLines[i]).toBe(line);
    }
    expect(fileLines.at(-1)).toBe("}");
    expect(body.split("\n")[3 + before.length]).toBe("```");
  });

  it("logs a count per class for the file, never the match", async () => {
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    const lines = h.logs.filter((l) => l.msg.includes("secrets redacted"));
    expect(lines).toEqual([
      {
        level: "info",
        msg: "repository source file: secrets redacted before ingest",
        meta: {
          connectorId: "c1",
          path: "src/config.ts",
          count: 2,
          byClass: { github_pat: 1, private_key: 1 },
        },
      },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain("MIIEvQIBADANBgkq");
  });

  it("re-embeds a file indexed before #2333 instead of skipping it as unchanged", async () => {
    // How main stored the file: unredacted, indexed, checksum of that body.
    const old = `# src/config.ts\n\n\`\`\`ts\n${CONFIG_TS}\n\`\`\`\n`;
    const oldChecksum = createHash("sha256").update(Buffer.from(old)).digest("hex");
    h.blobs.set(`blob/${oldChecksum}`, old);
    h.documents.set("doc_old", {
      id: "doc_old",
      projectId: "p1",
      filename: DOC("src/config.ts"),
      source: "repo",
      checksum: oldChecksum,
      storagePath: `blob/${oldChecksum}`,
      indexState: "indexed",
      chunkCount: 3,
      deletedAt: null,
    });
    const cleanBody = `# src/clean.ts\n\n\`\`\`ts\n${CLEAN_TS}\n\`\`\`\n`;
    const cleanChecksum = createHash("sha256").update(Buffer.from(cleanBody)).digest("hex");
    h.documents.set("doc_clean", {
      id: "doc_clean",
      projectId: "p1",
      filename: DOC("src/clean.ts"),
      source: "repo",
      checksum: cleanChecksum,
      storagePath: `blob/${cleanChecksum}`,
      indexState: "indexed",
      chunkCount: 1,
      deletedAt: null,
    });

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    // The file with a secret is re-embedded from a redacted body ...
    expect(summary.documentsUpdated).toBe(1);
    expect(h.documents.get("doc_old")!.checksum).not.toBe(oldChecksum);
    expect(h.embedded.get(DOC("src/config.ts"))).not.toContain(GH_TOKEN);
    // ... and a file with none yields the same bytes and is skipped, correctly.
    expect(h.embedded.has(DOC("src/clean.ts"))).toBe(false);
    expect(h.documents.get("doc_clean")!.checksum).toBe(cleanChecksum);
  });
});
