/**
 * #2347 — `GET /api/projects/:projectId/requirements`, the Requirements tab's
 * list, through the REAL router, auth, project-access check and a REAL SQLite
 * database built from the migration chain.
 *
 * Covers: rows across every change request, each with its change request's
 * title, review status and the latest standing review; server-side paging;
 * the change request, status and title filters (title case-insensitive); and
 * access: an outsider gets 404, another project's rows and run ids never
 * appear, and soft-deleted rows and runs are left out.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
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

const { projectRequirementsRouter } = await import("../src/routes/project-requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const P = "proj-2347";
const P_X = "proj-2347-x";

interface Row {
  id: string;
  title: string;
  reviewStatus: string;
  changeRequest: { id: string; title: string };
  review: { id: string; status: string; title: string } | null;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2347 — the project's requirements across change requests",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, role: RoleKey, workspaces: string[]) =>
      `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken
      }`;
    const ANA = () => bearer("u-ana", "developer", ["ws-a"]);
    const OUT = () => bearer("u-out", "developer", ["ws-x"]);
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/requirements", projectRequirementsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const list = async (query = "", auth = ANA(), project = P) =>
      request(app())
        .get(`/api/projects/${project}/requirements${query}`)
        .set("Authorization", auth);
    const items = async (query = "") => {
      const res = await list(query);
      expect(res.status).toBe(200);
      return res.body.data as { items: Row[]; total: number; page: number; pageSize: number };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2347-project-requirements");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-ana", "u-rev", "u-out"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-a", name: "a", slug: "ws-a" } });
      await db.workspace.create({ data: { id: "ws-x", name: "x", slug: "ws-x" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-a", userId: "u-ana", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-x", userId: "u-out", role: "member" },
      });
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "u-ana", workspaceId: "ws-a" },
      });
      await db.project.create({
        data: { id: P_X, name: P_X, slug: P_X, createdById: "u-out", workspaceId: "ws-x" },
      });
      const run = (id: string, projectId: string, title: string, deletedAt: Date | null = null) =>
        db.analysis.create({
          data: { id, projectId, startedById: "u-ana", status: "completed", title, deletedAt },
        });
      await run("cr-checkout", P, "Checkout redesign");
      await run("cr-refunds", P, "Refund policy");
      await run("cr-gone", P, "Deleted run", new Date());
      await run("cr-foreign", P_X, "Secret merger");
      const req = (
        id: string,
        analysisId: string,
        projectId: string,
        title: string,
        reviewStatus: string | null,
        deletedAt: Date | null = null,
      ) =>
        db.requirement.create({
          data: {
            id,
            analysisId,
            projectId,
            title,
            body: `${title} body`,
            reviewStatus,
            deletedAt,
          },
        });
      await req("r-pay", "cr-checkout", P, "Pay with a saved CARD", "approved");
      await req("r-guest", "cr-checkout", P, "Guest checkout", null);
      await req("r-email", "cr-checkout", P, "Email receipt", "rejected");
      await req("r-refund", "cr-refunds", P, "Refund within 30 days", "draft");
      await req("r-deleted", "cr-checkout", P, "Removed requirement", "draft", new Date());
      await req("r-in-gone-run", "cr-gone", P, "From a deleted run", "draft");
      await req("r-foreign", "cr-foreign", P_X, "Card vault for the merger", "draft");
      // A rejected review of two of them, then a later draft review of one.
      await db.reviewRequest.create({
        data: {
          id: "rev-old",
          projectId: P,
          title: "First sign-off",
          status: "rejected",
          requestedById: "u-ana",
          items: {
            create: [
              { requirementId: "r-pay", pinnedVersion: 0 },
              { requirementId: "r-email", pinnedVersion: 0 },
            ],
          },
        },
      });
      await db.reviewRequest.create({
        data: {
          id: "rev-closed",
          projectId: P,
          title: "Closed one",
          status: "closed",
          requestedById: "u-ana",
          items: { create: [{ requirementId: "r-guest", pinnedVersion: 0 }] },
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists every live requirement of the project, across its change requests", async () => {
      const page = await items();
      expect(page.total).toBe(4);
      expect(page.items.map((r) => r.id).sort()).toEqual(
        ["r-email", "r-guest", "r-pay", "r-refund"].sort(),
      );
      const pay = page.items.find((r) => r.id === "r-pay")!;
      expect(pay).toMatchObject({
        title: "Pay with a saved CARD",
        reviewStatus: "approved",
        changeRequest: { id: "cr-checkout", title: "Checkout redesign" },
        review: { id: "rev-old", status: "rejected", title: "First sign-off" },
      });
      // An unset status reads as awaiting review; a closed review is no state.
      expect(page.items.find((r) => r.id === "r-guest")).toMatchObject({
        reviewStatus: "draft",
        review: null,
      });
    });

    it("pages on the server", async () => {
      const first = await items("?page=1&pageSize=3");
      const second = await items("?page=2&pageSize=3");
      expect(first.items).toHaveLength(3);
      expect(second.items).toHaveLength(1);
      expect(first.total).toBe(4);
      expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(4);
    });

    it("filters by change request, by status and by title (case-insensitive)", async () => {
      expect((await items("?analysisId=cr-refunds")).items.map((r) => r.id)).toEqual(["r-refund"]);
      expect((await items("?status=draft")).items.map((r) => r.id).sort()).toEqual([
        "r-guest",
        "r-refund",
      ]);
      expect((await items("?status=rejected")).items.map((r) => r.id)).toEqual(["r-email"]);
      expect((await items("?q=card")).items.map((r) => r.id)).toEqual(["r-pay"]);
      // A wildcard in the term is literal, not a match-all.
      expect((await items("?q=%25")).total).toBe(0);
      expect((await items("?analysisId=cr-checkout&status=approved&q=pay")).total).toBe(1);
    });

    it("never lists another project's rows, even by naming its run", async () => {
      expect((await items("?analysisId=cr-foreign")).total).toBe(0);
      expect((await items("?q=merger")).total).toBe(0);
    });

    // #2347 review — the filter agrees with the status a row SHOWS (#1016): a
    // null column with a legacy `review:*` label reads as that label.
    it("files a legacy-labelled row under the status its row shows", async () => {
      const P_L = "proj-2347-legacy";
      // Seeded once, so a retry of this test reads the same rows.
      if (!(await db.project.findUnique({ where: { id: P_L } }))) await seedLegacy();
      async function seedLegacy() {
        await db.project.create({
          data: { id: P_L, name: P_L, slug: P_L, createdById: "u-ana", workspaceId: "ws-a" },
        });
        await db.analysis.create({
          data: { id: "cr-legacy", projectId: P_L, startedById: "u-ana", status: "completed" },
        });
        const legacy = (id: string, reviewStatus: string | null, labels: string[]) =>
          db.requirement.create({
            data: {
              id,
              analysisId: "cr-legacy",
              projectId: P_L,
              title: id,
              body: "",
              reviewStatus,
              labels: JSON.stringify(labels),
            },
          });
        await legacy("l-approved", null, ["billing", "review:approved"]);
        await legacy("l-rejected", null, ["review:rejected"]);
        await legacy("l-label-draft", null, ["review:draft"]);
        await legacy("l-plain", null, ["billing"]);
        // The typed column wins over a stale label, as every reader has it.
        await legacy("l-column-wins", "draft", ["review:approved"]);
      }

      const filtered = async (status: string) => {
        const res = await list(`?status=${status}`, ANA(), P_L);
        expect(res.status).toBe(200);
        const page = res.body.data as { items: Row[]; total: number };
        // Every row listed under a status SHOWS that status.
        for (const r of page.items) expect(r.reviewStatus, r.id).toBe(status);
        return page.items.map((r) => r.id).sort();
      };
      expect(await filtered("approved")).toEqual(["l-approved"]);
      expect(await filtered("rejected")).toEqual(["l-rejected"]);
      expect(await filtered("draft")).toEqual(["l-column-wins", "l-label-draft", "l-plain"]);
      expect(await filtered("deferred")).toEqual([]);
    });

    it("searches titles in the list's order, and says nothing is capped below the cap", async () => {
      const page = await items("?q=e");
      expect(page).toMatchObject({ totalIsLowerBound: false });
    });

    it("refuses a caller who cannot open the project, and bad queries", async () => {
      expect((await list("", OUT())).status).toBe(404);
      expect((await list("?status=done")).status).toBe(400);
      expect((await list("?pageSize=500")).status).toBe(400);
      expect((await list("?page=0")).status).toBe(400);
    });
  },
);
