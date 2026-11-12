/**
 * Issue #2341 — the change request: a titled analysis run that records what it
 * was started from.
 *
 * Proven through the real analysis router against a real SQLite database built
 * from the migration chain, with the real project-access check: the title is
 * written by the start route (the orchestrator is a stub that stores the row
 * the way the real one does, through `createAnalysis`) and by the rename route,
 * and every assertion reads it back through the list and snapshot routes a
 * real page uses.
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

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { createAnalysis } = await import("../src/lib/analysis/analysis-service.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { listReviews } = await import("../src/lib/reviews/review-service.js");
const { attachChangeRequests } = await import("../src/lib/reviews/review-change-requests.js");

const PROJECT = "proj-2341";
const FOREIGN_PROJECT = "proj-2341-foreign";
const LEGACY_RUN = "ana-2341-legacy";
const IMPORTED_RUN = "ana-2341-imported";
const FOREIGN_RUN = "ana-2341-foreign";

/** Stores the run as the real orchestrator does, without running any agent. */
const orchestrator = {
  start: vi.fn(async (opts: Parameters<typeof createAnalysis>[0] & Record<string, unknown>) => {
    const row = await createAnalysis({
      projectId: opts.projectId,
      startedById: opts.startedById,
      agentKeys: opts.agentKeys ?? ["document"],
      documentIds: opts.documentIds,
      extraInstructions: opts.extraInstructions,
      sourceRequirements: opts.sourceRequirements,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.startedWithDefaults ? { startedWithDefaults: true } : {}),
    });
    return { id: row.id };
  }),
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2341 — a titled change request, read back through the routes",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let DEV = "";
    let READER = "";
    let OUTSIDER = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      const routers = initAnalysisRouter({
        orchestrator: orchestrator as unknown as NonNullable<
          Parameters<typeof initAnalysisRouter>[0]
        >["orchestrator"],
      });
      a.use("/api/projects/:projectId/analyses", routers.projectScoped);
      a.use("/api/analyses", routers.topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const as = (bearer: string) => ({
      list: (project = PROJECT) =>
        request(app())
          .get(`/api/projects/${project}/analyses`)
          .set("Authorization", `Bearer ${bearer}`),
      get: (id: string) =>
        request(app()).get(`/api/analyses/${id}`).set("Authorization", `Bearer ${bearer}`),
      start: (body: Record<string, unknown>) =>
        request(app())
          .post(`/api/projects/${PROJECT}/analyses`)
          .set("Authorization", `Bearer ${bearer}`)
          .send(body),
      rename: (id: string, body: unknown, project = PROJECT) =>
        request(app())
          .patch(`/api/projects/${project}/analyses/${id}`)
          .set("Authorization", `Bearer ${bearer}`)
          .send(body as object),
    });
    const listed = async (id: string) => {
      const res = await as(DEV).list();
      expect(res.status).toBe(200);
      return (res.body.data.items as Array<Record<string, unknown>>).find((i) => i.id === id);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2341-change-request");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-dev", "u-read", "u-out"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-2341", name: "ws", slug: "ws-2341" } });
      await db.workspace.create({ data: { id: "ws-2341-x", name: "wsx", slug: "ws-2341-x" } });
      for (const [userId, workspaceId] of [
        ["u-dev", "ws-2341"],
        ["u-read", "ws-2341"],
        ["u-out", "ws-2341-x"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
      for (const [id, workspaceId] of [
        [PROJECT, "ws-2341"],
        [FOREIGN_PROJECT, "ws-2341-x"],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-out", workspaceId },
        });
      }
      const doc = (id: string, projectId: string, filename: string, title: string | null = null) =>
        db.document.create({
          data: {
            id,
            projectId,
            filename,
            title,
            mimeType: "text/plain",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            status: "ready",
            uploadedById: "u-out",
          },
        });
      await doc("doc-2341-brief", PROJECT, "checkout-brief.docx");
      await doc("doc-2341-page", PROJECT, "page-123.html", "Refund policy");
      await doc("doc-2341-foreign", FOREIGN_PROJECT, "secret-merger.docx");
      // A run from before #2341: no title, two chosen documents (one of them
      // another project's id, which must never name it).
      await db.analysis.create({
        data: {
          id: LEGACY_RUN,
          projectId: PROJECT,
          startedById: "u-dev",
          status: "completed",
          startedAt: new Date("2026-10-01T09:00:00Z"),
          metadata: JSON.stringify({ documentIds: ["doc-2341-page", "doc-2341-foreign"] }),
        },
      });
      await db.analysis.create({
        data: {
          id: IMPORTED_RUN,
          projectId: PROJECT,
          startedById: "u-dev",
          status: "completed",
          startedAt: new Date("2026-10-02T09:00:00Z"),
          metadata: JSON.stringify({
            documentIds: [],
            sourceRequirements: [
              {
                candidateId: "NR-1",
                requirementId: "req-ext-1",
                title: "Pay with a saved card",
                externalSource: "jira",
                externalId: "PAY-12",
                externalUrl: "https://jira.example.test/browse/PAY-12",
              },
            ],
          }),
        },
      });
      await db.analysis.create({
        data: {
          id: FOREIGN_RUN,
          projectId: FOREIGN_PROJECT,
          startedById: "u-out",
          status: "completed",
          title: "Foreign plans",
        },
      });
      const token = (userId: string, role: "developer" | "reader", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      // `developer` is the non-admin analyst role; `reader` holds no analysis.run.
      DEV = token("u-dev", "developer", ["ws-2341"]);
      READER = token("u-read", "reader", ["ws-2341"]);
      OUTSIDER = token("u-out", "developer", ["ws-2341-x"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("gives a run from before #2341 a generated title and lists its sources, never another project's document", async () => {
      const item = await listed(LEGACY_RUN);
      expect(item).toMatchObject({
        title: "Refund policy",
        titleGenerated: true,
        sources: {
          allDocuments: false,
          documents: [
            { id: "doc-2341-page", name: "Refund policy" },
            { id: "doc-2341-foreign", name: null },
          ],
          importedItems: [],
        },
      });
      expect(JSON.stringify(item)).not.toContain("secret-merger");
      const snap = await as(DEV).get(LEGACY_RUN);
      expect(snap.status).toBe(200);
      expect(snap.body.data).toMatchObject({ title: "Refund policy", titleGenerated: true });
    });

    it("names a run started from imported items after the first item, and shows the item", async () => {
      const item = await listed(IMPORTED_RUN);
      expect(item).toMatchObject({
        title: "Pay with a saved card",
        titleGenerated: true,
        sources: {
          allDocuments: true,
          documents: [],
          importedItems: [
            {
              requirementId: "req-ext-1",
              title: "Pay with a saved card",
              externalSource: "jira",
              externalId: "PAY-12",
            },
          ],
        },
      });
    });

    it("stores the first chosen document's name when a run starts without a title", async () => {
      const res = await as(DEV).start({ documentIds: ["doc-2341-brief", "doc-2341-page"] });
      expect(res.status).toBe(202);
      const id = res.body.data.id as string;
      const row = await db.analysis.findUniqueOrThrow({ where: { id } });
      expect(row.title).toBe("checkout-brief.docx and 1 more");
      expect(await listed(id)).toMatchObject({
        title: "checkout-brief.docx and 1 more",
        titleGenerated: false,
      });
    });

    it("stores the analyst's title, trimmed, and records a run started with defaults", async () => {
      const res = await as(DEV).start({
        title: "  Checkout v2  ",
        documentIds: ["doc-2341-brief"],
        startedWithDefaults: true,
      });
      expect(res.status).toBe(202);
      const snap = await as(DEV).get(res.body.data.id as string);
      expect(snap.body.data).toMatchObject({
        title: "Checkout v2",
        titleGenerated: false,
        metadata: { startedWithDefaults: true },
        sources: { documents: [{ id: "doc-2341-brief", name: "checkout-brief.docx" }] },
      });
    });

    it("refuses a start whose title is too long or not one line", async () => {
      for (const title of ["x".repeat(201), "two\nlines", "   "]) {
        const res = await as(DEV).start({ title });
        expect(res.status).toBe(400);
      }
    });

    it("renames a change request for an analyst, and the new title reads back as typed", async () => {
      const markup = "<img src=x onerror=alert(1)> **Refunds** [x](javascript:alert(1))";
      const res = await as(DEV).rename(LEGACY_RUN, { title: markup });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: LEGACY_RUN, title: markup });
      expect(await listed(LEGACY_RUN)).toMatchObject({ title: markup, titleGenerated: false });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "analysis.rename",
          target: { type: "analysis", id: LEGACY_RUN },
        }),
      );
    });

    it("refuses a rename by a user without write access, and leaves the title alone", async () => {
      const before = await db.analysis.findUniqueOrThrow({ where: { id: IMPORTED_RUN } });
      const res = await as(READER).rename(IMPORTED_RUN, { title: "Reader's name" });
      expect(res.status).toBe(403);
      const after = await db.analysis.findUniqueOrThrow({ where: { id: IMPORTED_RUN } });
      expect(after.title).toBe(before.title);
      // A reader still reads it.
      expect((await as(READER).list()).status).toBe(200);
    });

    it("answers 404 for another project's run, through this project, and never renames it", async () => {
      const res = await as(DEV).rename(FOREIGN_RUN, { title: "Hijacked" });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Foreign plans");
      const row = await db.analysis.findUniqueOrThrow({ where: { id: FOREIGN_RUN } });
      expect(row.title).toBe("Foreign plans");
      // And a project the caller is not a member of is refused before the handler.
      const outsider = await as(OUTSIDER).rename(LEGACY_RUN, { title: "Hijacked" });
      expect([403, 404]).toContain(outsider.status);
      expect((await db.analysis.findUniqueOrThrow({ where: { id: LEGACY_RUN } })).title).not.toBe(
        "Hijacked",
      );
    });

    it("names each review's change requests, distinct, from its own project only", async () => {
      const req = (id: string, analysisId: string, projectId = PROJECT) =>
        db.requirement.create({
          data: { id, projectId, analysisId, title: id, body: "b", version: 1 },
        });
      await req("req-2341-a", IMPORTED_RUN);
      await req("req-2341-b", IMPORTED_RUN);
      await req("req-2341-c", LEGACY_RUN);
      await req("req-2341-x", FOREIGN_RUN, FOREIGN_PROJECT);
      await db.analysis.update({ where: { id: IMPORTED_RUN }, data: { title: "Saved cards" } });
      await db.reviewRequest.create({
        data: {
          id: "rev-2341",
          projectId: PROJECT,
          title: "Sign off",
          requestedById: "u-dev",
          items: {
            create: ["req-2341-a", "req-2341-b", "req-2341-c"].map((requirementId) => ({
              requirementId,
              pinnedVersion: 1,
            })),
          },
        },
      });
      const page = await listReviews("u-dev", { projectId: PROJECT, page: 1, pageSize: 10 });
      const review = (page.reviews as Array<{ id: string; changeRequests: unknown }>).find(
        (r) => r.id === "rev-2341",
      );
      expect(review?.changeRequests).toEqual([
        { id: IMPORTED_RUN, title: "Saved cards" },
        { id: LEGACY_RUN, title: expect.any(String) },
      ]);

      // A forged item naming another project's requirement surfaces nothing of it.
      const [forged] = await attachChangeRequests([
        { projectId: PROJECT, items: [{ requirementId: "req-2341-x" }, { requirementId: null }] },
      ]);
      expect(forged!.changeRequests).toEqual([]);
    });

    it("refuses a rename of a deleted run, an empty title, and unknown fields", async () => {
      await db.analysis.create({
        data: {
          id: "ana-2341-deleted",
          projectId: PROJECT,
          startedById: "u-dev",
          status: "completed",
          deletedAt: new Date(),
        },
      });
      expect((await as(DEV).rename("ana-2341-deleted", { title: "Back" })).status).toBe(404);
      expect((await as(DEV).rename(IMPORTED_RUN, { title: "" })).status).toBe(400);
      expect((await as(DEV).rename(IMPORTED_RUN, { title: "x".repeat(201) })).status).toBe(400);
      expect(
        (await as(DEV).rename(IMPORTED_RUN, { title: "ok", projectId: FOREIGN_PROJECT })).status,
      ).toBe(400);
    });
  },
);
