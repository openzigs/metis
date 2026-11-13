/**
 * #2356 — `saveDocumentAcl`'s compare-and-set on real Postgres.
 *
 * The SQLite suite (`document-acl-save-2356.sqlite.test.ts`) forces the race
 * through the `afterRead` seam, one statement at a time: SQLite serialises
 * writers, so two saves never meet inside the database. Postgres runs them at
 * once under READ COMMITTED, and the claim is that the CAS still holds there:
 * the loser's `UPDATE … WHERE "aclSubjects" = <what it read>` blocks on the
 * winner's row lock, re-evaluates its WHERE against the committed row once the
 * lock is released, matches nothing, and the loser reads the ACL again.
 *
 * The interleaving is real, not simulated: Alice's save is held inside its
 * transaction right after its document UPDATE (so it holds the row lock), Bob's
 * save is started, and Alice is released only once Postgres reports Bob's
 * UPDATE waiting on a lock (`pg_stat_activity`).
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { saveDocumentAcl, AclGroupUnsupportedError } = await import("../src/lib/rag/acl.js");

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-2356pg-${SUFFIX}`;
const WORKSPACE = `ws-2356pg-${SUFFIX}`;
const PROJECT = `p-2356pg-${SUFFIX}`;
const DOC = `d-2356pg-${SUFFIX}`;
const LEGACY = JSON.stringify([
  { kind: "group", value: "legacy" },
  { kind: "user", value: "alice" },
]);

type Gate = { holding: Promise<void>; release: () => void };

/**
 * A client whose FIRST interactive transaction pauses right before its chunk
 * UPDATE (after the document UPDATE, so it holds the row lock) until released.
 * Every later transaction runs untouched.
 */
function holdFirstSave(db: PrismaClient): { client: PrismaClient; gate: Gate } {
  let signalHolding!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((r) => (signalHolding = r));
  const released = new Promise<void>((r) => (release = r));
  let first = true;

  const wrapTx = (tx: PrismaClient) => {
    const knowledgeChunk = new Proxy(tx.knowledgeChunk, {
      get(target, prop, receiver) {
        if (prop !== "updateMany") return Reflect.get(target, prop, receiver);
        return async (args: unknown) => {
          signalHolding();
          await released;
          return (target.updateMany as (a: unknown) => Promise<unknown>)(args);
        };
      },
    });
    return new Proxy(tx, {
      get: (target, prop, receiver) =>
        prop === "knowledgeChunk" ? knowledgeChunk : Reflect.get(target, prop, receiver),
    });
  };

  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: object) => {
        const held = first;
        first = false;
        return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
          (tx: PrismaClient) => fn(held ? wrapTx(tx) : tx),
          { timeout: 30_000, maxWait: 10_000, ...opts },
        );
      };
    },
  }) as PrismaClient;
  return { client, gate: { holding, release } };
}

/** Resolve once some session is waiting on a lock for an UPDATE of `documents`. */
async function untilUpdateWaitsOnLock(db: PrismaClient): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%update%documents%'`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the second save never waited on the document row lock");
}

describe.skipIf(!enabled)("#2356 — concurrent document ACL saves (Postgres)", () => {
  let db: PrismaClient;

  const acl = async () => (await db.document.findUniqueOrThrow({ where: { id: DOC } })).aclSubjects;
  const chunkAcls = async () =>
    (
      await db.knowledgeChunk.findMany({ where: { documentId: DOC }, orderBy: { position: "asc" } })
    ).map((c) => c.aclSubjects);

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
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
        filename: "policy.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        storagePath: "/tmp/policy.md",
        checksum: DOC,
        uploadedById: USER,
        status: "ready",
      },
    });
    for (const position of [0, 1]) {
      await db.knowledgeChunk.create({
        data: {
          id: `c-2356pg-${SUFFIX}-${position}`,
          projectId: PROJECT,
          documentId: DOC,
          position,
          text: `chunk ${position}`,
          md5: `md5-${SUFFIX}-${position}`,
          embeddingModel: "test",
        },
      });
    }
  });

  beforeEach(async () => {
    state.db = db;
    await db.document.update({ where: { id: DOC }, data: { aclSubjects: LEGACY } });
    await db.knowledgeChunk.updateMany({
      where: { documentId: DOC },
      data: { aclSubjects: LEGACY },
    });
  });

  afterAll(async () => {
    if (!db) return;
    // The document and its chunks cascade from the project.
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.$disconnect();
  });

  // The race #2356 names, on separate connections at once: Alice removes the
  // legacy group; Bob, whose editor still shows it, saves a list keeping it.
  // Bob read the ACL before Alice committed, so his group check passed against
  // a list that is about to stop holding the group.
  it("lets Alice's save win and refuses Bob's stale legacy group, on the document and every chunk", async () => {
    const alice = [{ kind: "user" as const, value: "alice" }];
    const bob = [
      { kind: "group" as const, value: "legacy" },
      { kind: "user" as const, value: "bob" },
    ];
    const { client, gate } = holdFirstSave(db);
    state.db = client;

    const aliceSave = saveDocumentAcl({ documentId: DOC, projectId: PROJECT, aclSubjects: alice });
    await gate.holding;
    const bobSave = saveDocumentAcl({
      documentId: DOC,
      projectId: PROJECT,
      aclSubjects: bob,
    }).catch((e: unknown) => e);
    await untilUpdateWaitsOnLock(db);
    gate.release();

    await expect(aliceSave).resolves.toEqual({ chunkCount: 2 });
    const bobResult = await bobSave;
    expect(bobResult).toBeInstanceOf(AclGroupUnsupportedError);
    expect((bobResult as InstanceType<typeof AclGroupUnsupportedError>).groups).toEqual(["legacy"]);
    expect(await acl()).toBe(JSON.stringify(alice));
    expect(await chunkAcls()).toEqual([JSON.stringify(alice), JSON.stringify(alice)]);
  });

  // Neither list adds a group: Bob's write loses the compare-and-set, he reads
  // Alice's committed list and saves over it, so the document and its chunks
  // always end on the same list, never a mix of the two.
  it("re-reads after losing the compare-and-set and lands one list on the document and every chunk", async () => {
    const alice = [{ kind: "user" as const, value: "alice" }];
    const bob = [{ kind: "user" as const, value: "bob" }];
    const { client, gate } = holdFirstSave(db);
    state.db = client;

    const aliceSave = saveDocumentAcl({ documentId: DOC, projectId: PROJECT, aclSubjects: alice });
    await gate.holding;
    const bobSave = saveDocumentAcl({ documentId: DOC, projectId: PROJECT, aclSubjects: bob });
    await untilUpdateWaitsOnLock(db);
    gate.release();

    await expect(aliceSave).resolves.toEqual({ chunkCount: 2 });
    await expect(bobSave).resolves.toEqual({ chunkCount: 2 });
    expect(await acl()).toBe(JSON.stringify(bob));
    expect(await chunkAcls()).toEqual([JSON.stringify(bob), JSON.stringify(bob)]);
  });
});
