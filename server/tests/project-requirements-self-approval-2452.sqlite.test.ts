/**
 * #2452 — the Requirements list says up front which rows the caller may not
 * approve because they wrote or edited them (maker-checker, #2436), instead of
 * the refusal arriving as a toast after the click.
 *
 * Through the REAL router, auth and project-access check, on a REAL SQLite
 * database from the migration chain. Authorship reads as the approve write's
 * check does: a version of theirs that changed the wording (title, body,
 * criteria; not labels), or an edit of theirs in the approval checkpoint. Only
 * a row the caller could otherwise approve carries the flag: not one already
 * approved, not for a role without requirement.approve, and not once the
 * project allows self-approval.
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
const { selfApprovalForbiddenIds } =
  await import("../src/lib/requirements/project-requirements-list.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const P = "proj-2452";
/** A second project in the same workspace, where u-coord also wrote and edited. */
const P2 = "proj-2452-other";

interface Row {
  id: string;
  reviewStatus: string;
  selfApprovalForbidden?: true;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2452 — the Requirements list flags the caller's own rows before Approve",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, role: RoleKey) =>
      `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces: ["ws-2452"],
        }).accessToken
      }`;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/requirements", projectRequirementsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const flagged = async (userId: string, role: RoleKey) => {
      const res = await request(app())
        .get(`/api/projects/${P}/requirements?pageSize=100`)
        .set("Authorization", bearer(userId, role));
      expect(res.status).toBe(200);
      const items = res.body.data.items as Row[];
      expect(items.length).toBeGreaterThan(0);
      return items
        .filter((r) => r.selfApprovalForbidden === true)
        .map((r) => r.id)
        .sort();
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2452-self-approval-list");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-coord", "u-other", "u-dev"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-2452", name: "w", slug: "ws-2452" } });
      for (const userId of ["u-coord", "u-other", "u-dev"]) {
        await db.workspaceMember.create({
          data: { workspaceId: "ws-2452", userId, role: "member" },
        });
      }
      for (const id of [P, P2]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-coord", workspaceId: "ws-2452" },
        });
      }
      // The checkpoint of run `run-1` recorded u-coord editing REQ-001.
      await db.analysis.create({
        data: {
          id: "cr-1",
          projectId: P,
          startedById: "u-other",
          status: "completed",
          title: "Checkout",
          metadata: JSON.stringify({
            checkpointRequirementEditors: { runId: "run-1", editors: { "REQ-001": ["u-coord"] } },
          }),
        },
      });
      const req = (
        id: string,
        reviewStatus: string,
        promoted?: { structuredId: string; runId: string },
      ) =>
        db.requirement.create({
          data: {
            id,
            analysisId: "cr-1",
            projectId: P,
            title: id,
            body: "",
            reviewStatus,
            ...(promoted
              ? {
                  promotedStructuredId: promoted.structuredId,
                  promotedStructuredRunId: promoted.runId,
                }
              : {}),
          },
        });
      await req("r-reworded", "draft");
      await version("r-reworded", "u-coord", ["title"]);
      await req("r-criteria", "rejected");
      await version("r-criteria", "u-coord", ["acceptanceCriteria"]);
      // Labels classify a requirement; changing them makes no one its author.
      await req("r-labels", "draft");
      await version("r-labels", "u-coord", ["labels"]);
      await req("r-theirs", "draft");
      await version("r-theirs", "u-other", ["body"]);
      await req("r-checkpoint", "draft", { structuredId: "REQ-001", runId: "run-1" });
      // Same structured id under another run: that run's editors are not this one's.
      await req("r-other-run", "draft", { structuredId: "REQ-001", runId: "run-0" });
      // Already approved: there is no Approve to explain.
      await req("r-approved", "approved");
      await version("r-approved", "u-coord", ["title"]);

      // P2: u-coord reworded one requirement and edited another in P2's checkpoint.
      await db.analysis.create({
        data: {
          id: "cr-2",
          projectId: P2,
          startedById: "u-other",
          status: "completed",
          title: "Other",
          metadata: JSON.stringify({
            checkpointRequirementEditors: { runId: "run-2", editors: { "REQ-002": ["u-coord"] } },
          }),
        },
      });
      const foreign = (
        id: string,
        projectId: string,
        analysisId: string,
        structuredId: string,
        runId: string,
      ) =>
        db.requirement.create({
          data: {
            id,
            analysisId,
            projectId,
            title: id,
            body: "",
            reviewStatus: "draft",
            promotedStructuredId: structuredId,
            promotedStructuredRunId: runId,
          },
        });
      await foreign("r-p2", P2, "cr-2", "REQ-002", "run-2");
      await version("r-p2", "u-coord", ["title"]);
      // Rows whose project and change request disagree, so each of the
      // checkpoint read's two project filters is pinned on its own.
      await foreign("r-p2-on-p-run", P2, "cr-1", "REQ-001", "run-1");
      await foreign("r-p-on-p2-run", P, "cr-2", "REQ-002", "run-2");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("flags the rows the caller wrote, edited or reworded in the checkpoint", async () => {
      expect(await flagged("u-coord", "coordinator")).toEqual(
        ["r-checkpoint", "r-criteria", "r-reworded"].sort(),
      );
    });

    it("flags only the colleague's own row for that colleague", async () => {
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

    it("never flags another project's requirement, whatever the caller did there", async () => {
      // Control: in its own project, u-coord's P2 rows are flagged.
      expect([...(await selfApprovalForbiddenIds(P2, ["r-p2"], "u-coord"))]).toEqual(["r-p2"]);
      const blocked = await selfApprovalForbiddenIds(
        P,
        ["r-reworded", "r-p2", "r-p2-on-p-run", "r-p-on-p2-run"],
        "u-coord",
      );
      expect([...blocked]).toEqual(["r-reworded"]);
    });

    it("flags nothing once the project allows self-approval", async () => {
      await db.project.update({ where: { id: P }, data: { allowSelfApproval: true } });
      try {
        expect(await flagged("u-coord", "coordinator")).toEqual([]);
      } finally {
        await db.project.update({ where: { id: P }, data: { allowSelfApproval: false } });
      }
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
