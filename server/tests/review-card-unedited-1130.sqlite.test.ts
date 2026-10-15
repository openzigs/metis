/**
 * #1130 — a review requested on a freshly promoted, never-edited set showed no
 * requirement text: version rows are written only by edits, so the pinned v0
 * had no history entry and every card fell back to "reference only".
 *
 * The history endpoint now returns the requirement as it was before its first
 * recorded change. Proven through the real review service, the real
 * requirements router (edit + history) and a real SQLite database built from the
 * migration chain: every pinned item resolves to its text as it was when the
 * review was requested, including one edited after the request.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { createReviewRequest, submitReview } = await import("../src/lib/reviews/review-service.js");

const PROJECT = "proj-1130";
const ANALYSIS = "ana-1130";
const REQUESTER = "u-1130-req";
const REVIEWER = "u-1130-rev";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1130 — review cards of a never-edited set have the pinned text",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const history = (id: string) =>
      request(app())
        .get(`/api/requirements/${id}/history?pageSize=100`)
        .set("Authorization", `Bearer ${TOKEN}`);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1130-review-card-unedited");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [REQUESTER, REVIEWER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1130", name: "ws", slug: "ws-1130" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1130", userId: REQUESTER, role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: REQUESTER,
          workspaceId: "ws-1130",
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
      });
      TOKEN = issueTokens({
        userId: REQUESTER,
        username: REQUESTER,
        role: "admin",
        permissions: [],
        workspaces: ["ws-1130"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("resolves every pinned item to its text as requested, with no version rows written", async () => {
      // A freshly promoted set: rows created as promotion creates them, no history.
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const row = await db.requirement.create({
          data: {
            id: `req-1130-${i}`,
            projectId: PROJECT,
            analysisId: ANALYSIS,
            title: `Mark all read ${i}`,
            body: `Users **mark** every entry read (${i}).`,
            priority: "high",
            acceptanceCriteria: JSON.stringify([`Criterion ${i}`]),
          },
        });
        ids.push(row.id);
      }
      expect(await db.requirementVersion.count({ where: { requirementId: { in: ids } } })).toBe(0);

      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: ids.map((requirementId) => ({ requirementId })),
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);
      const items = await db.reviewRequestItem.findMany({
        where: { reviewRequestId: created.id },
        select: { requirementId: true, pinnedVersion: true },
      });
      expect(items).toHaveLength(3);

      // Edit one AFTER the request: its card must still show the requested text.
      const current = await db.requirement.findUniqueOrThrow({
        where: { id: ids[0]! },
        select: { version: true },
      });
      const edit = await request(app())
        .put(`/api/requirements/${ids[0]}`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ version: current.version, body: "Rewritten after the review was requested." });
      expect(edit.status).toBe(200);

      for (const item of items) {
        const res = await history(item.requirementId!);
        expect(res.status).toBe(200);
        const { versions, original } = res.body.data as {
          versions: Array<{ version: number }>;
          original: { version: number; snapshot: Record<string, unknown> };
        };
        // The card's lookup: no row at the pinned version, the original is it.
        expect(versions.some((v) => v.version === item.pinnedVersion)).toBe(false);
        expect(original.version).toBe(item.pinnedVersion);
        const n = item.requirementId!.slice(-1);
        expect(original.snapshot.body).toBe(`Users **mark** every entry read (${n}).`);
        expect(original.snapshot.priority).toBe("high");
        expect(JSON.parse(original.snapshot.acceptanceCriteria as string)).toEqual([
          `Criterion ${n}`,
        ]);
      }
    });
  },
);
