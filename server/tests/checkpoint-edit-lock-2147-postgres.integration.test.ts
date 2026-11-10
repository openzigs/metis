/**
 * #2147 — the checkpoint requirement edit's approval-row lock, on real Postgres.
 *
 * `editCheckpointRequirement` (#1580) reads the approval, checks it is
 * `pending`, and rewrites the reviewed requirement in the analysis metadata.
 * On Postgres it locks the approval row `FOR UPDATE` first, so a review of the
 * same approval (`reviewApprovalRequest`'s conditional `UPDATE … WHERE status =
 * 'pending'`) waits for the edit to commit, and whatever approving then
 * promotes reads the edited text. Without the lock the review lands mid-edit:
 * the approval is approved while the edit still writes, so the text promoted
 * can be the text from before the edit.
 *
 * SQLite serialises interactive transactions, so only Postgres can show this.
 * The interleaving is forced, not raced: the edit is held inside its
 * transaction, just before its metadata write, while the review runs.
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
const { editCheckpointRequirement } =
  await import("../src/lib/analysis/checkpoint-requirement-edit.js");
const { reviewApprovalRequest } = await import("../src/lib/analysis/approval-checkpoint.js");

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-2147pg-${SUFFIX}`;
const WORKSPACE = `ws-2147pg-${SUFFIX}`;
const PROJECT = `proj-2147pg-${SUFFIX}`;
const TITLE = "Mark all entries older than a threshold as read";
const EDITED = "Mark entries published before X as read";

/** Long enough for an unblocked review to land several times over. */
const HELD_MS = 750;

/**
 * The database, with the next edit transaction held just before its metadata
 * write (after its locks and reads) until `release` is called.
 */
function holdingEdit(db: PrismaClient) {
  let reached!: () => void;
  const atHold = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const wrapTx = (tx: PrismaClient) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "analysis") return value;
        return new Proxy(value as PrismaClient["analysis"], {
          get(delegate, method, r) {
            const fn = Reflect.get(delegate, method, r) as unknown;
            if (method !== "update" || typeof fn !== "function") return fn;
            return async (...args: unknown[]) => {
              reached();
              await released;
              return (fn as (...a: unknown[]) => Promise<unknown>).apply(delegate, args);
            };
          },
        });
      },
    });
  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: object) =>
        (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
          (tx: PrismaClient) => fn(wrapTx(tx)),
          { timeout: 30_000, maxWait: 10_000, ...opts },
        );
    },
  });
  return { client, atHold, release };
}

describe.skipIf(!enabled)("#2147 — a review waits for a checkpoint edit (Postgres)", () => {
  let db: PrismaClient;
  let seq = 0;

  async function seedPending(): Promise<{ analysisId: string; approvalId: string }> {
    seq += 1;
    const analysisId = `ana-2147pg-${SUFFIX}-${seq}`;
    await db.analysis.create({
      data: {
        id: analysisId,
        projectId: PROJECT,
        startedById: USER,
        status: "completed",
        metadata: JSON.stringify({
          structuredRequirements: {
            requirements: [
              {
                id: "REQ-1",
                title: TITLE,
                description: `${TITLE}.`,
                type: "functional",
                stakeholders: [],
                priority: "must-have",
                ambiguities: [],
                evidenceNeeds: [],
                rawSource: "",
              },
            ],
            totalAmbiguities: 0,
            totalEvidenceNeeds: 0,
          },
        }),
      },
    });
    const approval = await db.approvalRequest.create({
      data: { analysisId, type: "requirement", itemId: "REQ-1", status: "pending" },
    });
    return { analysisId, approvalId: approval.id };
  }

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    state.db = db;
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
  });

  afterAll(async () => {
    if (!db) return;
    // Analyses and their approvals cascade from the project.
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.$disconnect();
  });

  it("holds a review of the same approval until the edit commits, then lands on the edited text", async () => {
    const { analysisId, approvalId } = await seedPending();
    const { client, atHold, release } = holdingEdit(db);
    const order: string[] = [];

    // #2167 — hoisted so the `finally` can wait for both, whichever line threw.
    let edit: Promise<unknown> | undefined;
    let review: Promise<unknown> | undefined;
    state.db = client;
    // #2157 — released and reset whatever happens: a red assertion used to
    // leave the edit's transaction held until its 30 s timeout.
    try {
      edit = editCheckpointRequirement(analysisId, approvalId, { title: EDITED }).then((r) => {
        order.push("edit committed");
        return r;
      });
      // #2167 — an edit that fails before its metadata write never reaches the
      // hold: its rejection ends the wait, not the test's 120 s timeout.
      await Promise.race([atHold, edit]);
      // The edit holds the approval row; the review's conditional UPDATE must wait.
      review = reviewApprovalRequest(analysisId, approvalId, {
        status: "approved",
        reviewerId: USER,
      }).then((r) => {
        order.push("review landed");
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
      expect(order, "the review landed while the edit held the approval").toEqual([]);

      release();
      await Promise.all([edit, review]);
    } finally {
      release();
      // #2167 — both settle before afterAll's cleanup deletes the rows they write.
      await Promise.allSettled([edit, review]);
      state.db = db;
    }

    expect(order).toEqual(["edit committed", "review landed"]);
    const approval = await db.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.status).toBe("approved");
    // What approving promotes reads this list: the edit is in it.
    const row = await db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
    const stored = JSON.parse(row.metadata ?? "{}") as {
      structuredRequirements: { requirements: Array<{ title: string; extractedTitle?: string }> };
    };
    expect(stored.structuredRequirements.requirements[0]).toMatchObject({
      title: EDITED,
      extractedTitle: TITLE,
    });
  });
});
