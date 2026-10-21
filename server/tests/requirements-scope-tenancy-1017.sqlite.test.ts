/**
 * #1017 — the requirements docs-generation scope (#991) against a REAL
 * migrated SQLite database, through the real generated-docs router, auth
 * middleware and project-access gate; only the audit sink is a double and no
 * model is called (a requirements-scoped document is built from stored rows).
 *
 * Workspace A holds project PA, with an analysis run, two requirements and a
 * review that pinned both. One requirement was edited after the review was
 * submitted. Workspace B holds project PB with its own run, requirement and
 * review. Alice is a coordinator in A, Mallory a coordinator in B.
 *
 * - Mallory naming PA, with any of PA's own selectors, gets 404 and creates
 *   nothing: the tenancy boundary is the workspace, not the selector.
 * - Alice naming PA with PB's selectors gets the empty-scope 400: an id from
 *   another project selects nothing, even for a member.
 * - Alice's own review-scoped document renders the PINNED text of the edited
 *   requirement, which is also the positive control for the 404 above.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
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
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { generatedDocsRouter } = await import("../src/routes/generated-docs.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");

const WS_A = "ws-a-1017";
const WS_B = "ws-b-1017";
const PA = "proj-a-1017";
const PB = "proj-b-1017";
const RUN_A = "run-a-1017";
const RUN_B = "run-b-1017";
const REVIEW_A = "review-a-1017";
const REVIEW_B = "review-b-1017";
const USERS = { alice: WS_A, mallory: WS_B } as const;
type Who = keyof typeof USERS;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1017 — requirements-scoped documents: tenancy and pinned review versions (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: "coordinator",
      permissions: getPermissionsForRole("coordinator"),
      workspaces: [USERS[who]],
    });
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/docs", generatedDocsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const generate = (who: Who, projectId: string, scopeFilter: Record<string, unknown>) =>
      request(app())
        .post(`/api/projects/${projectId}/docs/generate`)
        .set("Authorization", `Bearer ${issueTokens(payload(who)).accessToken}`)
        .send({ title: "Scoped BRD", scope: "requirements", scopeFilter });
    const docsIn = (projectId: string) => db.generatedDocument.count({ where: { projectId } });

    const requirement = (id: string, projectId: string, analysisId: string, title: string) =>
      db.requirement.create({
        data: {
          id,
          projectId,
          analysisId,
          title,
          body: `Body of ${title}.`,
          priority: "high",
          acceptanceCriteria: JSON.stringify([`Criterion of ${title}.`]),
        },
      });
    const review = async (id: string, projectId: string, by: Who, pins: [string, number][]) => {
      await db.reviewRequest.create({
        data: { id, projectId, title: `Review ${id}`, status: "in_review", requestedById: by },
      });
      for (const [requirementId, pinnedVersion] of pins) {
        await db.reviewRequestItem.create({
          data: { reviewRequestId: id, requirementId, pinnedVersion },
        });
      }
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1017-requirements-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      for (const [id, ws] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: "role-coordinator" } });
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({ data: { workspaceId: ws, userId: id, role: "member" } });
      }
      for (const [id, ws, by, run] of [
        [PA, WS_A, "alice", RUN_A],
        [PB, WS_B, "mallory", RUN_B],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: by, workspaceId: ws, status: "active" },
        });
        await db.analysis.create({
          data: { id: run, projectId: id, startedById: by, status: "completed" },
        });
      }
      await requirement("req-a-edited", PA, RUN_A, "Export invoices as CSV");
      await requirement("req-a-same", PA, RUN_A, "Keep an audit log");
      await requirement("req-b", PB, RUN_B, "Mallory's requirement");
      // Both pinned at version 0, as submitted.
      await review(REVIEW_A, PA, "alice", [
        ["req-a-edited", 0],
        ["req-a-same", 0],
      ]);
      await review(REVIEW_B, PB, "mallory", [["req-b", 0]]);
      // Edited after submission, through the versioned writer: now version 1.
      await updateRequirementWithHistory(db, {
        requirementId: "req-a-edited",
        patch: { title: "Export invoices as XLSX", body: "Rewritten after the review." },
        actorId: "alice",
        projectId: PA,
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it.each([
      ["a review", { reviewRequestId: REVIEW_A }],
      ["an analysis run", { analysisId: RUN_A }],
      ["selected requirements", { requirementIds: ["req-a-edited", "req-a-same"] }],
    ])(
      "a caller from another workspace gets 404 naming the project's own %s",
      async (_n, filter) => {
        const res = await generate("mallory", PA, filter);
        expect(res.status).toBe(404);
        expect(await docsIn(PA)).toBe(0);
      },
    );

    it.each([
      ["review", { reviewRequestId: REVIEW_B }],
      ["analysis run", { analysisId: RUN_B }],
      ["requirement", { requirementIds: ["req-b"] }],
    ])("a member naming another project's %s selects nothing (400)", async (_n, filter) => {
      const res = await generate("alice", PA, filter);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("REQUIREMENTS_SCOPE_EMPTY");
      expect(await docsIn(PA)).toBe(0);
    });

    it("a member's review-scoped document renders the versions the review pinned", async () => {
      const res = await generate("alice", PA, { reviewRequestId: REVIEW_A });
      expect(res.status).toBe(202);
      const docId = res.body.data.id as string;

      // Generation runs in the background; a requirements document calls no model.
      let doc = await db.generatedDocument.findUniqueOrThrow({ where: { id: docId } });
      const settled = ["ready", "failed", "cancelled"];
      for (let i = 0; i < 100 && !settled.includes(doc.status); i++) {
        await new Promise((r) => setTimeout(r, 100));
        doc = await db.generatedDocument.findUniqueOrThrow({ where: { id: docId } });
      }
      expect(doc.status, doc.errorMessage ?? "").toBe("ready");

      expect(doc.content).toContain("Export invoices as CSV");
      expect(doc.content).toContain("Body of Export invoices as CSV.");
      expect(doc.content).not.toContain("Export invoices as XLSX");
      expect(doc.content).not.toContain("Rewritten after the review.");
      expect(doc.content).toContain(
        "_Shown at version 0, the version the review pinned. It has changed since (now version 1)._",
      );
      expect(doc.content).toContain("Keep an audit log");
      expect(doc.content).not.toContain("Mallory's requirement");
    });
  },
);
