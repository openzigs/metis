/**
 * #2435 — approval and an access-list save, interleaved on real Postgres.
 *
 * `approveDocument` reads the document's ACL inside its final transaction,
 * after the `indexState` compare-and-set has taken the document row lock, and
 * writes it onto every chunk it creates. `saveDocumentAcl` updates the document
 * row before its chunks. Together that means a save which did not commit before
 * the CAS waits for approval to commit, then restricts the chunks approval just
 * made. SQLite serialises every writer, so the SQLite suite
 * (`rag-ingest-acl-edit-2435.sqlite.test.ts`) cannot see a reordering of either
 * side; this one can:
 *   - the ACL read moved above the CAS: the save never waits, commits between
 *     the read and the CAS, and approval writes the old list onto the chunks;
 *   - `saveDocumentAcl` updating chunks first: it updates the rows approval is
 *     deleting and misses the new ones, which keep the old list.
 *
 * The interleaving is real: approval is held inside its transaction right after
 * its ACL read, the save is started, and approval is released once Postgres
 * reports the save waiting on a lock (or the save has finished without one).
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AclSubject } from "@metis/shared";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { saveDocumentAcl } = await import("../src/lib/rag/acl.js");
const { approveDocument, writeQuarantine } = await import("../src/lib/rag/quarantine.js");
const { BM25Index } = await import("../src/lib/rag/bm25-index.js");
const { LocalVectorStore } = await import("../src/lib/rag/vector-store.js");

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-2435pg-${SUFFIX}`;
const WORKSPACE = `ws-2435pg-${SUFFIX}`;
const PROJECT = `p-2435pg-${SUFFIX}`;
const DOC = `d-2435pg-${SUFFIX}`;
const RESTRICTED: AclSubject[] = [{ kind: "user", value: "alice" }];

type Gate = { holding: Promise<void>; release: () => void };

/**
 * A client that pauses the first ACL read inside a transaction
 * (`tx.document.findFirst({ select: { aclSubjects: true } })`) right after it
 * returns, until released. Every other call runs untouched.
 */
function holdAclRead(db: PrismaClient): { client: PrismaClient; gate: Gate } {
  let signalHolding!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((r) => (signalHolding = r));
  const released = new Promise<void>((r) => (release = r));
  let held = false;

  const isAclRead = (args: unknown) => {
    const select = (args as { select?: Record<string, unknown> } | undefined)?.select;
    return !!select && Object.keys(select).length === 1 && select.aclSubjects === true;
  };
  const wrapTx = (tx: PrismaClient) => {
    const document = new Proxy(tx.document, {
      get(target, prop, receiver) {
        if (prop !== "findFirst") return Reflect.get(target, prop, receiver);
        const call = Reflect.get(target, prop, receiver) as (a: unknown) => Promise<unknown>;
        return async (args: unknown) => {
          const row = await call.call(target, args);
          if (!held && isAclRead(args)) {
            held = true;
            signalHolding();
            await released;
          }
          return row;
        };
      },
    });
    return new Proxy(tx, {
      get: (target, prop, receiver) =>
        prop === "document" ? document : Reflect.get(target, prop, receiver),
    });
  };

  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return (fn: unknown, opts?: object) => {
        if (typeof fn !== "function")
          return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(fn, opts);
        return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
          (tx: PrismaClient) => (fn as (tx: unknown) => Promise<unknown>)(wrapTx(tx)),
          { ...opts, timeout: 30_000, maxWait: 10_000 },
        );
      };
    },
  }) as PrismaClient;
  return { client, gate: { holding, release } };
}

/**
 * Resolve once some session is waiting on a lock for an UPDATE, or as soon as
 * `stop()` is true (the save finished without waiting).
 */
async function untilUpdateWaitsOnLock(db: PrismaClient, stop: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (stop()) return;
    const [row] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE 'update%'`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the save neither finished nor waited on a lock");
}

describe.skipIf(!enabled)("#2435 — an ACL save racing approval (Postgres)", () => {
  let db: PrismaClient;
  let vectorRoot: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    state.db = db;
    vectorRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2435pg-vectors-"));
    await db.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
    });
    await db.workspace.create({ data: { id: WORKSPACE, name: WORKSPACE, slug: WORKSPACE } });
    await db.project.create({
      data: {
        id: PROJECT,
        name: PROJECT,
        slug: PROJECT,
        createdById: USER,
        workspaceId: WORKSPACE,
      },
    });
    await db.document.create({
      data: {
        id: DOC,
        projectId: PROJECT,
        filename: "salary-bands.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        storagePath: "/tmp/salary-bands.md",
        checksum: DOC,
        uploadedById: USER,
        status: "processing",
      },
    });
    // A previous revision's live chunks: approval deletes these.
    for (const position of [0, 1]) {
      await db.knowledgeChunk.create({
        data: {
          id: `c-2435pg-${SUFFIX}-${position}`,
          projectId: PROJECT,
          documentId: DOC,
          position,
          text: `old chunk ${position}`,
          md5: `md5-${SUFFIX}-${position}`,
          embeddingModel: "test",
        },
      });
    }
    // Ingest names no ACL (#2435), so the document keeps its own (empty) list.
    await writeQuarantine({
      documentId: DOC,
      projectId: PROJECT,
      filename: "salary-bands.md",
      chunks: [
        { ord: 0, text: "band A", md5: "m0", embedding: [1, 0, 0, 0] },
        { ord: 1, text: "band B", md5: "m1", embedding: [0, 1, 0, 0] },
      ],
      embeddingModel: "test",
    });
  });

  afterAll(async () => {
    if (vectorRoot) rmSync(vectorRoot, { recursive: true, force: true });
    if (!db) return;
    // The document and its chunks cascade from the project.
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.$disconnect();
  });

  it("a save arriving after approval read the ACL restricts every chunk approval commits", async () => {
    expect((await db.document.findUniqueOrThrow({ where: { id: DOC } })).aclSubjects).toBe("[]");
    const { client, gate } = holdAclRead(db);
    state.db = client;

    const approved = approveDocument(
      DOC,
      { id: USER },
      { vectorStore: new LocalVectorStore({ root: vectorRoot }), bm25: new BM25Index() },
    );
    await gate.holding;
    let saved = false;
    const save = saveDocumentAcl({
      documentId: DOC,
      projectId: PROJECT,
      aclSubjects: RESTRICTED,
    }).finally(() => {
      saved = true;
    });
    await untilUpdateWaitsOnLock(db, () => saved);
    gate.release();

    await expect(approved).resolves.toEqual({ chunkCount: 2 });
    await save;

    expect((await db.document.findUniqueOrThrow({ where: { id: DOC } })).aclSubjects).toBe(
      JSON.stringify(RESTRICTED),
    );
    const chunks = await db.knowledgeChunk.findMany({
      where: { documentId: DOC },
      orderBy: { position: "asc" },
    });
    expect(chunks.map((c) => c.text)).toEqual(["band A", "band B"]);
    // The column is what search filters on (`KnowledgeService.search`).
    expect(chunks.map((c) => c.aclSubjects)).toEqual([
      JSON.stringify(RESTRICTED),
      JSON.stringify(RESTRICTED),
    ]);
  });
});
