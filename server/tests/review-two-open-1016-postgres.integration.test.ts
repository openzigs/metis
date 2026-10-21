/**
 * #1016 — two open reviews of one requirement withdrawn at the same moment
 * still give the requirement its status back (Postgres).
 *
 * Leaving a review restores a requirement only when no other open review covers
 * it. Under READ COMMITTED, two withdraws racing could each still read the other
 * review as open (neither has committed) and both skip the restore, leaving the
 * requirement "awaiting review" with no review open. The service locks the
 * scope's requirement rows before that read, so the second withdraw waits for
 * the first to commit and then sees it.
 *
 * The interleaving is forced: the first withdraw pauses right after it read
 * which other reviews are open; the second withdraw then starts on its own
 * connection. With the lock it waits (`pg_stat_activity` shows it waiting on a
 * lock); once the first commits, the second sees no other open review and
 * restores. Without the lock it would finish first, having skipped the restore.
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
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { createReviewRequest, submitReview, withdrawReview } =
  await import("../src/lib/reviews/review-service.js");

const SUFFIX = randomUUID().slice(0, 8);
const REQUESTER = `u-1016pg-req-${SUFFIX}`;
const REVIEWER = `u-1016pg-rev-${SUFFIX}`;
const WORKSPACE = `ws-1016pg-${SUFFIX}`;
const PROJECT = `proj-1016pg-${SUFFIX}`;
const ANALYSIS = `ana-1016pg-${SUFFIX}`;
/** Tags the second withdraw's connections so the lock probe sees only them. */
const APP_NAME = `metis-1016pg-${SUFFIX}`;

function taggedUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("application_name", APP_NAME);
  return u.toString();
}

describe.skipIf(!enabled)("#1016 — two open reviews withdrawn at once (Postgres)", () => {
  let db: PrismaClient;
  /** The second requester's connection, separate from the first's pool. */
  let other: PrismaClient;
  let observer: PrismaClient;
  let seq = 0;

  /**
   * The client the first withdraw sees: identical to `db`, except that its
   * first `reviewRequestItem.findMany` (the "is another review open?" read)
   * calls `afterRead` before returning.
   */
  let afterRead: (() => Promise<void>) | null = null;
  const pausingClient = () => {
    const hook = {
      query: {
        reviewRequestItem: {
          async findMany({
            args,
            query,
          }: {
            args: unknown;
            query: (a: unknown) => Promise<unknown>;
          }) {
            const rows = await query(args);
            const pause = afterRead;
            if (pause) {
              afterRead = null;
              await pause();
            }
            return rows;
          },
        },
      },
    };
    return db.$extends(hook as never);
  };

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

  const makeRequirement = async (reviewStatus: string) => {
    seq += 1;
    const row = await db.requirement.create({
      data: {
        id: `req-1016pg-${SUFFIX}-${seq}`,
        projectId: PROJECT,
        analysisId: ANALYSIS,
        title: `Requirement ${seq}`,
        body: "body",
        reviewStatus,
      },
    });
    return row.id;
  };

  const openReview = async (ids: string[]) => {
    state.db = db;
    const created = (await createReviewRequest(REQUESTER, PROJECT, {
      title: "Sign-off",
      policy: "all",
      reviewerIds: [REVIEWER],
      items: ids.map((requirementId) => ({ requirementId })),
    })) as { id: string };
    await submitReview(REQUESTER, created.id, false);
    return created.id;
  };

  const status = async (id: string) =>
    (await db.requirement.findUniqueOrThrow({ where: { id }, select: { reviewStatus: true } }))
      .reviewStatus;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    other = new PrismaClient({ adapter: selectPrismaAdapter(taggedUrl(databaseUrl)) });
    observer = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    for (const id of [REQUESTER, REVIEWER]) {
      await db.user.create({
        data: { id, username: id, displayName: id, email: `${id}@example.test` },
      });
    }
    await db.workspace.create({ data: { id: WORKSPACE, name: WORKSPACE, slug: WORKSPACE } });
    await db.project.create({
      data: {
        id: PROJECT,
        name: PROJECT,
        slug: PROJECT,
        createdById: REQUESTER,
        workspaceId: WORKSPACE,
      },
    });
    await db.analysis.create({
      data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
    });
  });

  afterAll(async () => {
    if (db) {
      // Requirements, reviews and the analysis cascade from the project.
      await db.reviewRequest.deleteMany({ where: { projectId: PROJECT } });
      await db.project.deleteMany({ where: { id: PROJECT } });
      await db.workspace.deleteMany({ where: { id: WORKSPACE } });
      await db.auditLog.deleteMany({ where: { actorId: { in: [REQUESTER, REVIEWER] } } });
      await db.user.deleteMany({ where: { id: { in: [REQUESTER, REVIEWER] } } });
    }
    await Promise.all([db?.$disconnect(), other?.$disconnect(), observer?.$disconnect()]);
  });

  it("the second withdraw waits for the first, then restores the requirement", async () => {
    const req = await makeRequirement("rejected");
    const first = await openReview([req]);
    const second = await openReview([req]);
    expect(await status(req)).toBe("draft");

    let secondWithdraw: Promise<unknown> | null = null;
    let secondState: "blocked" | "settled" | null = null;
    afterRead = async () => {
      // The first withdraw has read that the second review is still open.
      // The second requester now withdraws theirs, on another connection.
      state.db = other;
      secondWithdraw = withdrawReview(REQUESTER, second, false);
      secondState = await blockedOrSettled(secondWithdraw);
    };

    state.db = pausingClient();
    await withdrawReview(REQUESTER, first, false);
    state.db = db;

    expect(secondWithdraw).not.toBeNull();
    await secondWithdraw;

    // The second withdraw was held behind the first's lock on the requirement …
    expect(secondState).toBe("blocked");
    // … so it saw the first review withdrawn, and restored the status.
    expect(await status(req)).toBe("rejected");
    const reviews = await db.reviewRequest.findMany({
      where: { id: { in: [first, second] } },
      select: { status: true },
    });
    expect(reviews.map((r) => r.status)).toEqual(["draft", "draft"]);
  });

  it("two withdraws started together leave no requirement awaiting a review nobody holds", async () => {
    const reqs = [await makeRequirement("rejected"), await makeRequirement("deferred")];
    const first = await openReview(reqs);
    const second = await openReview([...reqs].reverse());

    state.db = db;
    await Promise.all([
      withdrawReview(REQUESTER, first, false),
      withdrawReview(REQUESTER, second, false),
    ]);

    expect(await status(reqs[0]!)).toBe("rejected");
    expect(await status(reqs[1]!)).toBe("deferred");
  });
});
