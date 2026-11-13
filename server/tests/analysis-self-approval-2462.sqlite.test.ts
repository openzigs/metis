/**
 * #2462 — the change request page says up front which requirements the caller
 * may not approve because they wrote or edited them (maker-checker, #2436), as
 * the Requirements list does (#2452), instead of the refusal arriving as a
 * toast after the click.
 *
 * Through the REAL `GET /api/analyses/:id` (auth and access check included) on
 * a REAL SQLite database from the migration chain. Authorship reads as the
 * approve write's check does (`selfApprovalForbiddenIds`, shared with the
 * list). Only a requirement the caller could otherwise approve carries the
 * flag: not one already approved, not for a role without requirement.approve,
 * and not once the project allows self-approval. The flag is advice: the
 * approve write still refuses the author on its own.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { RoleKey } from "@metis/shared";
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
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-2462";
const P = "proj-2462";
const CR = "cr-2462";

interface Card {
  id: string;
  reviewStatus: string;
  selfApprovalForbidden?: true;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2462 — the change request page flags the caller's own requirements before Approve",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, role: RoleKey) =>
      `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: [],
          workspaces: [WS],
        }).accessToken
      }`;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const cards = async (userId: string, role: RoleKey) => {
      const res = await request(app())
        .get(`/api/analyses/${CR}`)
        .set("Authorization", bearer(userId, role));
      expect(res.status).toBe(200);
      const items = res.body.data.requirements as Card[];
      expect(items.length).toBe(5);
      return items;
    };
    const flagged = async (userId: string, role: RoleKey) =>
      (await cards(userId, role))
        .filter((r) => r.selfApprovalForbidden === true)
        .map((r) => r.id)
        .sort();

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2462-self-approval-analysis");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "w", slug: WS } });
      for (const id of ["u-coord", "u-other", "u-dev"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: id, role: "member" } });
      }
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "u-coord", workspaceId: WS },
      });
      // The checkpoint of run `run-1` recorded u-coord editing REQ-001.
      await db.analysis.create({
        data: {
          id: CR,
          projectId: P,
          startedById: "u-other",
          status: "completed",
          title: "Checkout",
          metadata: JSON.stringify({
            checkpointRequirementEditors: { runId: "run-1", editors: { "REQ-001": ["u-coord"] } },
          }),
        },
      });
      const req = (id: string, reviewStatus: string, promoted = false) =>
        db.requirement.create({
          data: {
            id,
            analysisId: CR,
            projectId: P,
            title: id,
            body: "",
            reviewStatus,
            ...(promoted
              ? { promotedStructuredId: "REQ-001", promotedStructuredRunId: "run-1" }
              : {}),
          },
        });
      await req("r-reworded", "draft");
      await version("r-reworded", "u-coord", ["title"]);
      await req("r-checkpoint", "rejected", true);
      // Labels classify a requirement; changing them makes no one its author.
      await req("r-labels", "draft");
      await version("r-labels", "u-coord", ["labels"]);
      await req("r-theirs", "draft");
      await version("r-theirs", "u-other", ["body"]);
      // Already approved: there is no Approve to explain.
      await req("r-approved", "approved");
      await version("r-approved", "u-coord", ["title"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("flags the requirements the caller reworded or edited in the checkpoint, and no others", async () => {
      expect(await flagged("u-coord", "coordinator")).toEqual(["r-checkpoint", "r-reworded"]);
    });

    it("leaves every other card exactly as it was: no flag key at all", async () => {
      const unflagged = (await cards("u-coord", "coordinator")).filter(
        (r) => r.id !== "r-checkpoint" && r.id !== "r-reworded",
      );
      for (const r of unflagged) expect(r).not.toHaveProperty("selfApprovalForbidden");
    });

    it("flags only the colleague's own requirement for that colleague", async () => {
      expect(await flagged("u-other", "coordinator")).toEqual(["r-theirs"]);
    });

    it("flags nothing for a role that cannot approve at all (its reason is the permission)", async () => {
      await version("r-reworded", "u-dev", ["title"], 2);
      try {
        expect(await flagged("u-dev", "developer")).toEqual([]);
      } finally {
        await db.requirementVersion.deleteMany({
          where: { requirementId: "r-reworded", actorId: "u-dev" },
        });
      }
    });

    it("flags nothing once the project allows self-approval", async () => {
      await db.project.update({ where: { id: P }, data: { allowSelfApproval: true } });
      try {
        expect(await flagged("u-coord", "coordinator")).toEqual([]);
      } finally {
        await db.project.update({ where: { id: P }, data: { allowSelfApproval: false } });
      }
    });

    it("still refuses the author's approve write, whatever the page was shown", async () => {
      const res = await request(app())
        .put(`/api/requirements/r-reworded`)
        .set("Authorization", bearer("u-coord", "coordinator"))
        .send({ reviewStatus: "approved" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
      const row = await db.requirement.findUniqueOrThrow({ where: { id: "r-reworded" } });
      expect(row.reviewStatus).toBe("draft");
    });

    /** A version row by `actorId` that changed `fields` (`{ field: { from, to } }`). */
    async function version(requirementId: string, actorId: string, fields: string[], n = 1) {
      await db.requirementVersion.create({
        data: {
          requirementId,
          version: n,
          actorId,
          changedFields: JSON.stringify(
            Object.fromEntries(fields.map((f) => [f, { from: "a", to: "b" }])),
          ),
        },
      });
    }
  },
);
