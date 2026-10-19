/**
 * #930 — the analysis-row lock behind every metadata merge, on real Postgres.
 *
 * `mergeAnalysisMetadata` (every `persistAnalysisEnhancement` write) and
 * `lockRequirementSet` (the promotion append and the set replacement) open
 * with `SELECT … FROM "analyses" … FOR NO KEY UPDATE`. The unit fake only
 * checks the call order and that the read goes through the transaction
 * client; it cannot show that the lock does what #909 needed. This does:
 *
 *   1. a metadata writer that starts while the append holds the lock waits,
 *      then reads the append's committed metadata — the append's
 *      `promotedStructuredIds` is not overwritten with a stale copy (#909);
 *   2. a second `lockRequirementSet` waits for the first, so two appends of one
 *      analysis run one after the other;
 *   3. `FOR NO KEY UPDATE`, not `FOR UPDATE`: a row that merely references the
 *      analysis (an approval request) is inserted without waiting.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
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

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { lockRequirementSet, persistAnalysisEnhancement } =
  await import("../src/lib/analysis/analysis-service.js");

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-930pg-${SUFFIX}`;
const WORKSPACE = `ws-930pg-${SUFFIX}`;
const PROJECT = `proj-930pg-${SUFFIX}`;
const ANALYSIS = `ana-930pg-${SUFFIX}`;
/** Tags the waiting side's connections so the lock probe sees only them. */
const APP_NAME = `metis-930pg-${SUFFIX}`;

function taggedUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("application_name", APP_NAME);
  return u.toString();
}

describe.skipIf(!enabled)("#930 — the analysis-row metadata lock (Postgres)", () => {
  /** The append's side: holds the lock. */
  let db: PrismaClient;
  /** The side that must wait (or must not), tagged for the probe. */
  let other: PrismaClient;
  let observer: PrismaClient;

  /** Resolves once a tagged connection is waiting on a lock, or `settled` settles. */
  async function blockedOrSettled(settled: Promise<unknown>): Promise<"blocked" | "settled"> {
    let done = false;
    void settled.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 200; i += 1) {
      if (done) return "settled";
      const rows = await observer.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = ${APP_NAME}
           AND wait_event_type = 'Lock'`;
      if (Number(rows[0]?.n ?? 0) > 0) return "blocked";
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("neither blocked nor settled within 10s");
  }

  /**
   * Opens a transaction on `db` that takes `lockRequirementSet` and then waits
   * for `release()`; `then` runs inside it before it commits.
   */
  function holdLock(
    then: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<void>,
  ) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const done = db.$transaction(
      async (tx) => {
        await lockRequirementSet(tx as never, ANALYSIS);
        locked();
        await gate;
        await then(tx);
      },
      { timeout: 30_000 },
    );
    return { isLocked, release, done };
  }

  const metadata = async (): Promise<Record<string, unknown>> => {
    const row = await db.analysis.findFirst({
      where: { id: ANALYSIS },
      select: { metadata: true },
    });
    return JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
  };

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    other = new PrismaClient({ adapter: selectPrismaAdapter(taggedUrl(databaseUrl)) });
    observer = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
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
      data: {
        id: ANALYSIS,
        projectId: PROJECT,
        startedById: USER,
        status: "completed",
        metadata: JSON.stringify({ seeded: true }),
      },
    });
  });

  afterAll(async () => {
    if (db) {
      await db.project.deleteMany({ where: { id: PROJECT } });
      await db.workspace.deleteMany({ where: { id: WORKSPACE } });
      await db.user.deleteMany({ where: { id: USER } });
    }
    await Promise.all([db?.$disconnect(), other?.$disconnect(), observer?.$disconnect()]);
  });

  it("a metadata merge waits for the append and keeps what the append committed", async () => {
    const append = holdLock(async (tx) => {
      const row = await tx.analysis.findFirst({
        where: { id: ANALYSIS },
        select: { metadata: true },
      });
      const current = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      await tx.analysis.update({
        where: { id: ANALYSIS },
        data: { metadata: JSON.stringify({ ...current, promotedStructuredIds: ["REQ-1"] }) },
      });
    });
    await append.isLocked;

    state.db = other;
    const merge = persistAnalysisEnhancement(ANALYSIS, { promotionStatus: "allowed" });
    const merging = await blockedOrSettled(merge);
    append.release();
    await append.done;
    await merge;
    state.db = db;

    expect(merging).toBe("blocked");
    // Unlocked, the merge read `{ seeded }` before the append committed and
    // wrote it back over `promotedStructuredIds`.
    expect(await metadata()).toMatchObject({
      seeded: true,
      promotedStructuredIds: ["REQ-1"],
      promotionStatus: "allowed",
    });
  });

  it("a second lockRequirementSet on the same analysis waits for the first", async () => {
    const first = holdLock(async () => undefined);
    await first.isLocked;

    const second = other.$transaction(async (tx) => {
      await lockRequirementSet(tx as never, ANALYSIS);
    });
    const waiting = await blockedOrSettled(second);
    first.release();
    await first.done;
    await second;

    expect(waiting).toBe("blocked");
  });

  it("is FOR NO KEY UPDATE: a row referencing the analysis is inserted without waiting", async () => {
    const held = holdLock(async () => undefined);
    await held.isLocked;

    const insert = other.approvalRequest.create({
      data: { analysisId: ANALYSIS, type: "requirement", itemId: "REQ-9", status: "pending" },
    });
    const inserting = await blockedOrSettled(insert);
    held.release();
    await held.done;
    await insert;

    expect(inserting).toBe("settled");
  });
});
