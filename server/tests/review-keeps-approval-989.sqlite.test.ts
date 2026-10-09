/**
 * #989 — requesting a review used to reset every approved requirement in its
 * scope to draft, and neither a withdraw nor a close gave the approval back.
 *
 * Now an approved requirement stays approved while it is under review (only a
 * rejection moves it), the status each requirement held at submit is captured
 * on the review item, and leaving `in_review` without a verdict restores it.
 *
 * Proven through the real review service against a real SQLite database built
 * from the migration chain, read back through a fresh query — nothing on the
 * write path is mocked except the fire-and-forget notifications.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));

const { createReviewRequest, submitReview, withdrawReview, closeReview, recordDecision } =
  await import("../src/lib/reviews/review-service.js");

const PROJECT = "proj-989";
const ANALYSIS = "ana-989";
const REQUESTER = "u-989-req";
const REVIEWER = "u-989-rev";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#989 — a review keeps approvals and restores prior statuses",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const makeRequirement = async (reviewStatus: string | null) => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-989-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "body",
          reviewStatus,
        },
      });
      return row.id;
    };

    const statuses = async (ids: string[]) => {
      const rows = await db.requirement.findMany({
        where: { id: { in: ids } },
        select: { id: true, reviewStatus: true },
      });
      return Object.fromEntries(rows.map((r) => [r.id, r.reviewStatus]));
    };

    const openReview = async (ids: string[]) => {
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: ids.map((requirementId) => ({ requirementId })),
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);
      return created.id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("989-review-keeps-approval");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [REQUESTER, REVIEWER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: REQUESTER },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      seq += 100;
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("leaves approved requirements approved on submit; the rest await review", async () => {
      const approved = await makeRequirement("approved");
      const rejected = await makeRequirement("rejected");
      const unset = await makeRequirement(null);

      await openReview([approved, rejected, unset]);

      expect(await statuses([approved, rejected, unset])).toEqual({
        [approved]: "approved",
        [rejected]: "draft",
        [unset]: "draft",
      });
    });

    it("restores every prior status when the review is withdrawn", async () => {
      const approved = await makeRequirement("approved");
      const rejected = await makeRequirement("rejected");
      const deferred = await makeRequirement("deferred");
      const unset = await makeRequirement(null);
      const ids = [approved, rejected, deferred, unset];

      const reviewId = await openReview(ids);
      await withdrawReview(REQUESTER, reviewId, false);

      expect(await statuses(ids)).toEqual({
        [approved]: "approved",
        [rejected]: "rejected",
        [deferred]: "deferred",
        [unset]: null,
      });
    });

    it("restores prior statuses when an in-review review is closed", async () => {
      const approved = await makeRequirement("approved");
      const rejected = await makeRequirement("rejected");

      const reviewId = await openReview([approved, rejected]);
      await closeReview(REQUESTER, reviewId, false);

      expect(await statuses([approved, rejected])).toEqual({
        [approved]: "approved",
        [rejected]: "rejected",
      });
    });

    it("does not overwrite a status set by someone else while the review was open", async () => {
      const rejected = await makeRequirement("rejected");

      const reviewId = await openReview([rejected]);
      await db.requirement.update({ where: { id: rejected }, data: { reviewStatus: "deferred" } });
      await withdrawReview(REQUESTER, reviewId, false);

      expect(await statuses([rejected])).toEqual({ [rejected]: "deferred" });
    });

    it("a rejection still moves an approved requirement, and closing keeps the verdict", async () => {
      const approved = await makeRequirement("approved");

      const reviewId = await openReview([approved]);
      await recordDecision(REVIEWER, reviewId, "rejected");
      expect(await statuses([approved])).toEqual({ [approved]: "rejected" });

      await closeReview(REQUESTER, reviewId, false);
      expect(await statuses([approved])).toEqual({ [approved]: "rejected" });
    });
  },
);
