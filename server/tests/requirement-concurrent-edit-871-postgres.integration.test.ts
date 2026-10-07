/**
 * #871 — concurrent requirement edits with the same version (Postgres).
 *
 * On SQLite the driver adapter serializes interactive transactions, so a
 * version compare inside the transaction is enough. Postgres runs them
 * concurrently under READ COMMITTED: two transactions can BOTH read version N
 * inside their transaction before either writes. The write is therefore
 * conditional (`UPDATE … WHERE id = ? AND version = N`); the loser's UPDATE
 * blocks on the winner's row lock, re-evaluates its WHERE against the committed
 * row (version N+1), matches nothing, and the edit is a `VERSION_CONFLICT`.
 *
 * The interleaving is forced: each transaction, right after its first
 * requirement read, waits until the other has read too. Without the guarded
 * write, the loser's UPDATE succeeded and its history insert hit the
 * `(requirementId, version)` unique index — a 500, not a 409.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectPrismaAdapter } from "../src/lib/prisma.js";
import {
  RequirementVersionError,
  updateRequirementWithHistory,
  type VersionPrismaClient,
} from "../src/lib/requirements/requirement-version-service.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-871pg-${SUFFIX}`;
const WORKSPACE = `ws-871pg-${SUFFIX}`;
const PROJECT = `proj-871pg-${SUFFIX}`;
const ANALYSIS = `ana-871pg-${SUFFIX}`;

/**
 * A client whose next `parties` interactive transactions each pause right after
 * their FIRST `requirement.findUnique` until all of them have made that read.
 */
function readBarrierClient(db: PrismaClient, parties: number): VersionPrismaClient {
  let arrived = 0;
  let release!: () => void;
  const allRead = new Promise<void>((resolve) => (release = resolve));
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("read barrier never filled")), 20_000).unref(),
  );

  const wrapTx = (tx: PrismaClient) => {
    let first = true;
    const requirement = new Proxy(tx.requirement, {
      get(target, prop, receiver) {
        if (prop !== "findUnique") return Reflect.get(target, prop, receiver);
        return async (args: unknown) => {
          const row = await (target.findUnique as (a: unknown) => Promise<unknown>)(args);
          if (first) {
            first = false;
            arrived += 1;
            if (arrived === parties) release();
            await Promise.race([allRead, timeout]);
          }
          return row;
        };
      },
    });
    return new Proxy(tx, {
      get: (target, prop, receiver) =>
        prop === "requirement" ? requirement : Reflect.get(target, prop, receiver),
    });
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: object) =>
        (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
          (tx: PrismaClient) => fn(wrapTx(tx)),
          { timeout: 30_000, maxWait: 10_000, ...opts },
        );
    },
  }) as unknown as VersionPrismaClient;
}

describe.skipIf(!enabled)("#871 — concurrent same-version requirement edits (Postgres)", () => {
  let db: PrismaClient;
  let seq = 0;

  const makeRequirement = async () => {
    seq += 1;
    const row = await db.requirement.create({
      data: {
        id: `req-871pg-${SUFFIX}-${seq}`,
        projectId: PROJECT,
        analysisId: ANALYSIS,
        title: "Original",
        body: "The original body",
        version: 1,
      },
    });
    return row.id;
  };

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
    await db.analysis.create({
      data: { id: ANALYSIS, projectId: PROJECT, startedById: USER, status: "completed" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    // Requirements, versions and the analysis cascade from the project.
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.$disconnect();
  });

  it("lets exactly one of two same-version edits win; the other is a VERSION_CONFLICT", async () => {
    const id = await makeRequirement();
    const client = readBarrierClient(db, 2);

    const results = await Promise.allSettled([
      updateRequirementWithHistory(client, {
        requirementId: id,
        patch: { title: "Edit A" },
        expectedVersion: 1,
      }),
      updateRequirementWithHistory(client, {
        requirementId: id,
        patch: { title: "Edit B" },
        expectedVersion: 1,
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(RequirementVersionError);
    expect(reason).toMatchObject({ code: "VERSION_CONFLICT" });

    const winnerTitle = results[0]!.status === "fulfilled" ? "Edit A" : "Edit B";
    expect((won[0] as PromiseFulfilledResult<{ version: number }>).value.version).toBe(2);
    const row = await db.requirement.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ title: winnerTitle, version: 2 });
    const history = await db.requirementVersion.findMany({ where: { requirementId: id } });
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0]!.changedFields)).toEqual({
      title: { from: "Original", to: winnerTitle },
    });
  });

  it("applies two concurrent UNVERSIONED edits in turn, with a gap-free history", async () => {
    const id = await makeRequirement();
    const client = readBarrierClient(db, 2);

    const results = await Promise.all([
      updateRequirementWithHistory(client, { requirementId: id, patch: { title: "Edit A" } }),
      updateRequirementWithHistory(client, { requirementId: id, patch: { body: "Edit B body" } }),
    ]);

    expect(results.map((r) => r.version).sort()).toEqual([2, 3]);
    const row = await db.requirement.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ title: "Edit A", body: "Edit B body", version: 3 });
    const versions = (
      await db.requirementVersion.findMany({
        where: { requirementId: id },
        orderBy: { version: "asc" },
      })
    ).map((v) => v.version);
    expect(versions).toEqual([2, 3]);
  });
});
