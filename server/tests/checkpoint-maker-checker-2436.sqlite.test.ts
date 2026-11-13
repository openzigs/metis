/**
 * #2436 — maker-checker on the approval checkpoint.
 *
 * Someone who rewords a requirement in the checkpoint (#1580) is one of its
 * authors. If they also sign the checkpoint off — as the promoter, or as the
 * reviewer of that requirement's own checkpoint approval — the requirement is
 * promoted awaiting review (`draft`), not approved, and the response says so,
 * unless the project allows self-approval. The editor then cannot approve the
 * promoted row on the list either; a colleague can.
 *
 * Through the REAL checkpoint routes (edit, review) and the REAL requirement
 * write route, against a REAL SQLite database built by the migration chain,
 * with real JWTs. Every outcome is read back from the database.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { CHECKPOINT_HELD_REASON, CHECKPOINT_HELD_KEY } =
  await import("../src/lib/analysis/checkpoint-authorship.js");
const { persistRequirements, CHECKPOINT_APPROVED_IDS_KEY } =
  await import("../src/lib/analysis/analysis-service.js");
const { synthesisItemKey } = await import("../src/lib/analysis/promotion-pairing.js");

const WORKSPACE = "ws-2436-cp";
const PROJECT = "proj-2436-cp";
const RUN_ID = "run-2436-cp";
const MAKER = "u-2436-cp-maker";
const CHECKER = "u-2436-cp-checker";
const ROLE: Record<string, RoleKey> = { [MAKER]: "coordinator", [CHECKER]: "coordinator" };

const structured = (id: string, title: string) => ({
  id,
  title,
  description: `${title}.`,
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});
const R1 = structured("REQ-1", "Mark all entries older than a threshold as read");
const R2 = structured("REQ-2", "Archive feeds older than a year");
const item = (title: string) => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: [`${title} works.`],
});
const REWORDED = "Mark entries published before a date as read";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2436 — maker-checker on the approval checkpoint",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const bearer = (userId: string) =>
      `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role: ROLE[userId]!,
          permissions: getPermissionsForRole(ROLE[userId]!),
          workspaces: [WORKSPACE],
        }).accessToken
      }`;
    const editInCheckpoint = (userId: string, analysisId: string, approvalId: string) =>
      request(app())
        .patch(
          `/api/projects/${PROJECT}/analyses/${analysisId}/approvals/${approvalId}/requirement`,
        )
        .set("Authorization", bearer(userId))
        .send({ title: REWORDED });
    const review = (userId: string, analysisId: string, approvalId: string) =>
      request(app())
        .put(`/api/projects/${PROJECT}/analyses/${analysisId}/approvals/${approvalId}`)
        .set("Authorization", bearer(userId))
        .send({ status: "approved" });
    const approveRow = (userId: string, id: string) =>
      request(app())
        .put(`/api/requirements/${id}`)
        .set("Authorization", bearer(userId))
        .send({ reviewStatus: "approved" });
    const allowSelfApproval = (on: boolean) =>
      db.project.update({ where: { id: PROJECT }, data: { allowSelfApproval: on } });
    const rowsOf = async (analysisId: string) =>
      Object.fromEntries(
        (
          await db.requirement.findMany({
            where: { analysisId },
            select: { id: true, promotedStructuredId: true, reviewStatus: true, title: true },
          })
        ).map((r) => [r.promotedStructuredId!, r]),
      );
    const metadataOf = async (analysisId: string) =>
      JSON.parse(
        (await db.analysis.findUniqueOrThrow({ where: { id: analysisId } })).metadata ?? "{}",
      ) as Record<string, unknown>;

    /** A run at its checkpoint: two reviewed requirements, both pending. */
    async function seedCheckpoint() {
      seq += 1;
      const id = `ana-2436-cp-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: MAKER,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [R1, R2],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: RUN_ID,
          }),
        },
      });
      await db.agentResult.create({
        data: {
          analysisId: id,
          agentKey: "synthesis",
          status: "completed",
          output: JSON.stringify({
            summary: "Two requirements.",
            requirements: [item(R1.title), item(R2.title)],
          }),
        },
      });
      const approvals: Record<string, string> = {};
      for (const itemId of ["REQ-1", "REQ-2"]) {
        const row = await db.approvalRequest.create({
          data: { analysisId: id, type: "requirement", itemId, status: "pending" },
        });
        approvals[itemId] = row.id;
      }
      return { id, approvals };
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2436-checkpoint-maker-checker");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      for (const id of [MAKER, CHECKER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.workspaceMember.create({
          data: { workspaceId: WORKSPACE, userId: id, role: "member" },
        });
      }
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: CHECKER,
          workspaceId: WORKSPACE,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await allowSelfApproval(false);
    });

    it("the editor who signs the checkpoint off promotes their wording awaiting review, and says so", async () => {
      const { id, approvals } = await seedCheckpoint();
      expect((await editInCheckpoint(MAKER, id, approvals["REQ-1"]!)).status).toBe(200);

      expect((await review(MAKER, id, approvals["REQ-1"]!)).status).toBe(200);
      const res = await review(MAKER, id, approvals["REQ-2"]!);

      expect(res.status).toBe(200);
      expect(res.body.data.promotion).toEqual({
        status: "promoted",
        requirementCount: 2,
        heldForReviewCount: 1,
        heldForReviewReason: CHECKPOINT_HELD_REASON,
      });
      const rows = await rowsOf(id);
      expect(rows["REQ-1"]).toMatchObject({ title: REWORDED, reviewStatus: "draft" });
      // The one they did not write is approved, as before.
      expect(rows["REQ-2"]!.reviewStatus).toBe("approved");
      // Only the approved row is the checkpoint's decision (#939).
      expect((await metadataOf(id))[CHECKPOINT_APPROVED_IDS_KEY]).toEqual([rows["REQ-2"]!.id]);
    });

    it("the editor cannot then approve the held requirement on the list; a colleague can", async () => {
      const { id, approvals } = await seedCheckpoint();
      await editInCheckpoint(MAKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-2"]!);
      const held = (await rowsOf(id))["REQ-1"]!;

      const own = await approveRow(MAKER, held.id);
      expect(own.status).toBe(403);
      expect(own.body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
      expect((await rowsOf(id))["REQ-1"]!.reviewStatus).toBe("draft");

      expect((await approveRow(CHECKER, held.id)).status).toBe(200);
      expect((await rowsOf(id))["REQ-1"]!.reviewStatus).toBe("approved");
    });

    it("holds a requirement whose own checkpoint reviewer edited it, whoever promotes", async () => {
      const { id, approvals } = await seedCheckpoint();
      await editInCheckpoint(MAKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-1"]!);
      // A colleague's approval of the other requirement triggers the promotion.
      const res = await review(CHECKER, id, approvals["REQ-2"]!);

      expect(res.body.data.promotion).toMatchObject({ status: "promoted", heldForReviewCount: 1 });
      const rows = await rowsOf(id);
      expect(rows["REQ-1"]!.reviewStatus).toBe("draft");
      expect(rows["REQ-2"]!.reviewStatus).toBe("approved");
    });

    it("a colleague's edit is approved by whoever signs off without touching it", async () => {
      const { id, approvals } = await seedCheckpoint();
      await editInCheckpoint(CHECKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-1"]!);
      const res = await review(MAKER, id, approvals["REQ-2"]!);

      expect(res.body.data.promotion).toEqual({ status: "promoted", requirementCount: 2 });
      const rows = await rowsOf(id);
      expect(rows["REQ-1"]).toMatchObject({ title: REWORDED, reviewStatus: "approved" });
      expect(rows["REQ-2"]!.reviewStatus).toBe("approved");
    });

    it("with self-approval allowed, the editor's sign-off approves their wording as before", async () => {
      await allowSelfApproval(true);
      const { id, approvals } = await seedCheckpoint();
      await editInCheckpoint(MAKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-1"]!);
      const res = await review(MAKER, id, approvals["REQ-2"]!);

      expect(res.body.data.promotion).toEqual({ status: "promoted", requirementCount: 2 });
      const rows = await rowsOf(id);
      expect(rows["REQ-1"]).toMatchObject({ title: REWORDED, reviewStatus: "approved" });
      expect(rows["REQ-2"]!.reviewStatus).toBe("approved");
      expect((await metadataOf(id))[CHECKPOINT_HELD_KEY]).toBeUndefined();
    });

    it("a re-save of the same run keeps the held requirement awaiting review", async () => {
      const { id, approvals } = await seedCheckpoint();
      await editInCheckpoint(MAKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-1"]!);
      await review(MAKER, id, approvals["REQ-2"]!);

      // What the orchestrator's regenerate re-save writes: the reviewed set,
      // `approved`, paired to the same run — with nothing held by the caller.
      const items = [item(REWORDED), item(R2.title)];
      await persistRequirements({
        analysisId: id,
        projectId: PROJECT,
        synthesis: { summary: "Two requirements.", requirements: items } as never,
        findingIdsByIndex: [],
        reviewStatus: "approved",
        promotedFrom: {
          runId: RUN_ID,
          pairings: [
            { structuredId: "REQ-1", synthesisKeys: [synthesisItemKey(items[0]!)] },
            { structuredId: "REQ-2", synthesisKeys: [synthesisItemKey(items[1]!)] },
          ],
        },
      });

      const rows = await rowsOf(id);
      expect(rows["REQ-1"]!.reviewStatus).toBe("draft");
      expect(rows["REQ-2"]!.reviewStatus).toBe("approved");
      expect((await metadataOf(id))[CHECKPOINT_APPROVED_IDS_KEY]).toEqual([rows["REQ-2"]!.id]);
    });
  },
);
