/**
 * #930 — concurrent approval reviews on a REAL database, shared by the SQLite
 * test (`approval-review-race-930.sqlite.test.ts`) and its Postgres twin
 * (`approval-review-race-930-postgres.integration.test.ts`), so one body proves
 * the conditional write on both engines.
 *
 * `reviewApprovalRequest` used to read the status, check it was `pending`, then
 * update by id. Two reviewers acting at once both read `pending`, both passed,
 * and the last write silently replaced the first decision. The `pending`
 * predicate now rides the write (`updateMany where { status: "pending" }`), so
 * the database decides: exactly one review lands, the other is a 409.
 *
 * The interleaving is FORCED, not raced. The suite hands the code a client
 * whose `approvalRequest` delegate lets each racer's first call run and then
 * holds it until every racer's first call has returned. Under the old
 * check-then-act code those first calls are every reviewer's status READ, so
 * every reviewer sees `pending` before anyone writes — and more than one review
 * succeeds. Under the conditional write they are every reviewer's WRITE, which
 * the database serialises. Every outcome is read back from the rows.
 *
 * The calling file must `vi.mock` `lib/prisma.js` so `prisma` returns
 * `state.db`, before importing this module.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviewApprovalRequest } from "../../src/lib/analysis/approval-checkpoint.js";

export interface ApprovalRaceState {
  db: unknown;
}

/** Holds the first `size` delegate calls, once they return, until all have returned. */
interface Barrier {
  size: number;
  remaining: number;
  arrived: number;
  open: Promise<void>;
  release: () => void;
}

function newBarrier(size: number): Barrier {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return { size, remaining: size, arrived: 0, open, release };
}

/**
 * Wrap `db` so the first `size` `approvalRequest` calls after arming each run,
 * then wait until all of them have returned; later calls go straight through.
 * A barrier that never fills opens after `fallbackMs`, so a change to the code
 * under test fails an assertion instead of hanging the suite.
 */
function gated(db: PrismaClient, current: () => Barrier | null, fallbackMs: number): PrismaClient {
  const delegate = db.approvalRequest as unknown as Record<string, unknown>;
  const wrapped = new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const barrier = current();
        const held = barrier !== null && barrier.remaining > 0;
        if (held) barrier.remaining -= 1;
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (held) {
          // Held AFTER the call returns: every racer has finished its first
          // statement before any racer issues its second. Holding before the
          // call let one racer read and write before another's read ran (a
          // fresh pool connection is slow to open), so the race passed by luck.
          barrier.arrived += 1;
          if (barrier.arrived === barrier.size) barrier.release();
          const timer = setTimeout(barrier.release, fallbackMs);
          await barrier.open;
          clearTimeout(timer);
        }
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "approvalRequest") return wrapped;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

export function describeApprovalReviewRace(opts: {
  title: string;
  /** Skip the whole suite (wrong engine, integration tests not enabled). */
  skip: boolean;
  state: ApprovalRaceState;
  /** Opens the real database; called once in `beforeAll`. */
  open: () => Promise<PrismaClient>;
  /** Closes it and removes anything `open` created. */
  close: () => Promise<void>;
  /** Unique per run, so a shared Postgres database never collides. */
  suffix: string;
  hookTimeoutMs?: number;
}): void {
  const { state, suffix } = opts;
  const USER = `u-930race-${suffix}`;
  const WORKSPACE = `ws-930race-${suffix}`;
  const PROJECT = `proj-930race-${suffix}`;
  const ANALYSIS = `ana-930race-${suffix}`;

  describe.skipIf(opts.skip)(opts.title, () => {
    let db: PrismaClient;
    let barrier: Barrier | null = null;
    let seq = 0;

    /** One fresh pending approval per test, so no test reads another's decision. */
    async function pendingApproval(): Promise<string> {
      seq += 1;
      const row = await db.approvalRequest.create({
        data: { analysisId: ANALYSIS, type: "requirement", itemId: `REQ-${seq}` },
      });
      return row.id;
    }

    /** Run `calls` with their first `calls.length` delegate calls held together. */
    async function together<T>(calls: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
      barrier = newBarrier(calls.length);
      try {
        return await Promise.allSettled(calls.map((call) => call()));
      } finally {
        barrier = null;
      }
    }

    beforeAll(async () => {
      db = await opts.open();
      state.db = gated(db, () => barrier, 2_000);
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
    }, opts.hookTimeoutMs);

    afterAll(async () => {
      if (db) {
        await db.project.deleteMany({ where: { id: PROJECT } });
        await db.workspace.deleteMany({ where: { id: WORKSPACE } });
        await db.user.deleteMany({ where: { id: USER } });
      }
      await opts.close();
    });

    beforeEach(() => {
      barrier = null;
    });

    it("approve and reject at the same moment: one decision lands whole, the other is a 409", async () => {
      const id = await pendingApproval();

      const results = await together([
        () =>
          reviewApprovalRequest(ANALYSIS, id, {
            status: "approved",
            reviewerId: "reviewer-a",
            reviewNote: "Looks right",
          }),
        () =>
          reviewApprovalRequest(ANALYSIS, id, {
            status: "rejected",
            reviewerId: "reviewer-b",
            reviewNote: "Out of scope",
          }),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason).toMatchObject({
        statusCode: 409,
        code: "APPROVAL_ALREADY_REVIEWED",
      });

      // The stored row is the winner's decision, whole — never one reviewer's
      // status with the other's note — and the winner was told what is stored.
      const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id } });
      const winner = won[0]!.value;
      expect({
        status: stored.status,
        reviewerId: stored.reviewerId,
        reviewNote: stored.reviewNote,
      }).toEqual({
        status: winner.status,
        reviewerId: winner.reviewerId,
        reviewNote: winner.reviewNote,
      });
      expect(
        stored.status === "approved"
          ? { reviewerId: "reviewer-a", reviewNote: "Looks right" }
          : { reviewerId: "reviewer-b", reviewNote: "Out of scope" },
      ).toEqual({ reviewerId: stored.reviewerId, reviewNote: stored.reviewNote });
      expect(stored.reviewedAt).not.toBeNull();
    });

    it("five reviewers at once: exactly one wins and four are told it was already reviewed", async () => {
      const id = await pendingApproval();

      const results = await together(
        [0, 1, 2, 3, 4].map(
          (i) => () =>
            reviewApprovalRequest(ANALYSIS, id, {
              status: i % 2 === 0 ? "approved" : "rejected",
              reviewerId: `reviewer-${i}`,
            }),
        ),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(lost).toHaveLength(4);
      for (const r of lost) {
        expect(r.reason).toMatchObject({ statusCode: 409, code: "APPROVAL_ALREADY_REVIEWED" });
      }
    });

    it("a review that arrives after the decision changes nothing", async () => {
      const id = await pendingApproval();
      await reviewApprovalRequest(ANALYSIS, id, { status: "approved", reviewerId: "first" });
      const before = await db.approvalRequest.findUniqueOrThrow({ where: { id } });

      await expect(
        reviewApprovalRequest(ANALYSIS, id, { status: "rejected", reviewerId: "second" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_ALREADY_REVIEWED" });

      expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toEqual(before);
    });

    it("a review scoped to another analysis is a 404 and leaves the approval pending", async () => {
      const id = await pendingApproval();

      await expect(
        reviewApprovalRequest(`${ANALYSIS}-other`, id, { status: "approved", reviewerId: "x" }),
      ).rejects.toMatchObject({ statusCode: 404, code: "APPROVAL_NOT_FOUND" });

      const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("pending");
      expect(stored.reviewerId).toBeNull();
    });
  });
}
