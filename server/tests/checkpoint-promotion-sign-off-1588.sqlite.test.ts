/**
 * #1588 — approving the analysis checkpoint promotes requirements `approved`
 * only for a caller holding `project.update`.
 *
 * Since #1566 both requirement write routes demand `project.update`, but the
 * checkpoint routes are gated by `analysis.run`, which `developer` holds — so a
 * developer could still produce approved requirements by approving the
 * checkpoint of an analysis they ran. The owner's decision: the checkpoint stays
 * open to `analysis.run`, and what it promotes depends on the caller — with
 * `project.update` the rows are `approved`, without it `draft`.
 *
 * Every role is driven through every checkpoint route that can promote (the
 * review PUT, approve-all, promote, reject-added) and through the append a
 * reopened-then-approved requirement takes, against a real SQLite database
 * built from the migration chain, with real JWTs and the real permission
 * middleware. Each promoted row's `reviewStatus` is read back from the database.
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
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WORKSPACE = "ws-1588";
const PROJECT = "proj-1588";
const RUN_ID = "extraction-run-1588";

/** Each role: may it run the checkpoint at all, and what does it promote as? */
const ROLES: { role: RoleKey; promotesAs: "approved" | "draft" | null }[] = [
  { role: "reader", promotesAs: null },
  { role: "developer", promotesAs: "draft" },
  { role: "coordinator", promotesAs: "approved" },
  { role: "admin", promotesAs: "approved" },
];

const structured = (id: string, title: string) => ({
  id,
  title,
  description: `${title}, as the stakeholders asked.`,
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});
const R1 = structured("REQ-1", "Export the monthly invoice report");
const R2 = structured("REQ-2", "Archive feeds older than a year");
const item = (title: string, structuredIds: string[], sourceIds: string[]) => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: [`${title} works.`],
  structuredIds,
  sourceIds,
});
/** The imported item the run was started from: REQ-1 restates it, REQ-2 was added. */
const SOURCE = {
  candidateId: "NR-1",
  requirementId: "src-req-1",
  title: "Export the monthly invoice report",
  externalSource: "jira",
  externalId: "INV-1",
  externalUrl: null,
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1588 — checkpoint promotion is approved only with project.update",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const userId = (role: RoleKey) => `u-1588-${role}`;
    const tokenFor = (role: RoleKey) =>
      issueTokens({
        userId: userId(role),
        username: userId(role),
        role,
        permissions: [],
        workspaces: [WORKSPACE],
      }).accessToken;
    const base = (analysisId: string) => `/api/projects/${PROJECT}/analyses/${analysisId}`;

    /**
     * A completed run whose checkpoint holds one `requirement` approval per
     * structured requirement, in the given statuses. Run from an imported item
     * (`sourceRequirements`) so reject-added has an added requirement to reject.
     */
    async function seedAnalysis(statuses: { r1: string; r2: string }) {
      seq += 1;
      const id = `ana-1588-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: userId("admin"),
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [R1, R2],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: RUN_ID,
            sourceRequirements: [SOURCE],
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
            requirements: [item(R1.title, ["REQ-1"], ["NR-1"]), item(R2.title, ["REQ-2"], [])],
          }),
        },
      });
      const approvals: Record<string, string> = {};
      for (const [itemId, status] of [
        ["REQ-1", statuses.r1],
        ["REQ-2", statuses.r2],
      ] as const) {
        const row = await db.approvalRequest.create({
          data: {
            analysisId: id,
            type: "requirement",
            itemId,
            status,
            ...(status === "pending" ? {} : { reviewedAt: new Date() }),
          },
        });
        approvals[itemId] = row.id;
      }
      return { id, approvals };
    }

    /** Each promoted row's structured id and review status, read from the database. */
    const promoted = async (analysisId: string) =>
      (
        await db.requirement.findMany({
          where: { analysisId },
          select: { promotedStructuredId: true, reviewStatus: true },
        })
      )
        .map((r) => [r.promotedStructuredId, r.reviewStatus] as const)
        .sort(([a], [b]) => String(a).localeCompare(String(b)));

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1588-checkpoint-promotion-sign-off");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      for (const { role } of ROLES) {
        const id = userId(role);
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        // Every role is a member of the project's workspace, so the only thing
        // that differs between them is the role the token carries.
        await db.workspaceMember.create({
          data: { workspaceId: WORKSPACE, userId: id, role: "member" },
        });
      }
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: userId("admin"),
          workspaceId: WORKSPACE,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /**
     * Each checkpoint route that promotes: the approvals it starts from, the
     * request, and the rows it promotes (every row's status is the caller's).
     */
    const ROUTES = [
      {
        name: "PUT /approvals/:approvalId (the last pending approval)",
        start: { r1: "approved", r2: "pending" },
        send: (analysisId: string, approvals: Record<string, string>) =>
          request(app())
            .put(`${base(analysisId)}/approvals/${approvals["REQ-2"]}`)
            .send({ status: "approved" }),
        rows: ["REQ-1", "REQ-2"],
      },
      {
        name: "POST /approvals/approve-all",
        start: { r1: "pending", r2: "pending" },
        send: (analysisId: string) =>
          request(app())
            .post(`${base(analysisId)}/approvals/approve-all`)
            .send({}),
        rows: ["REQ-1", "REQ-2"],
      },
      {
        name: "POST /approvals/promote",
        start: { r1: "approved", r2: "approved" },
        send: (analysisId: string) =>
          request(app())
            .post(`${base(analysisId)}/approvals/promote`)
            .send({}),
        rows: ["REQ-1", "REQ-2"],
      },
      {
        name: "POST /approvals/reject-added",
        start: { r1: "approved", r2: "pending" },
        send: (analysisId: string) =>
          request(app())
            .post(`${base(analysisId)}/approvals/reject-added`)
            .send({}),
        rows: ["REQ-1"],
      },
    ] as const;

    for (const route of ROUTES) {
      describe(route.name, () => {
        for (const { role, promotesAs } of ROLES) {
          it(
            promotesAs
              ? `${role}: promotes as ${promotesAs}`
              : `${role}: refused, nothing promoted`,
            async () => {
              const { id, approvals } = await seedAnalysis(route.start);

              const res = await route
                .send(id, approvals)
                .set("Authorization", `Bearer ${tokenFor(role)}`);

              if (!promotesAs) {
                expect(res.status).toBe(403);
                expect(res.body.error).toMatchObject({
                  code: "FORBIDDEN",
                  message: "Requires permission analysis.run",
                });
                expect(await promoted(id)).toEqual([]);
                return;
              }
              expect(res.status).toBe(200);
              expect(res.body.data.promotion).toEqual({
                status: "promoted",
                requirementCount: route.rows.length,
              });
              expect(await promoted(id)).toEqual(route.rows.map((r) => [r, promotesAs]));
            },
          );
        }
      });
    }

    // #723 — a rejection reopened and approved AFTER the set was promoted is
    // appended (never a replacement). The appended row takes the status of the
    // caller who approved it; the row already promoted keeps its own.
    describe("a reopened requirement approved after promotion (the append)", () => {
      for (const { role, promotesAs } of ROLES.filter((r) => r.promotesAs)) {
        it(`${role}: the appended row is ${promotesAs}; the earlier row is unchanged`, async () => {
          const { id, approvals } = await seedAnalysis({ r1: "approved", r2: "rejected" });
          const promote = await request(app())
            .post(`${base(id)}/approvals/promote`)
            .set("Authorization", `Bearer ${tokenFor("coordinator")}`)
            .send({});
          expect(promote.body.data.promotion).toEqual({ status: "promoted", requirementCount: 1 });

          const reopen = await request(app())
            .post(`${base(id)}/approvals/${approvals["REQ-2"]}/reopen`)
            .set("Authorization", `Bearer ${tokenFor(role)}`)
            .send({});
          expect(reopen.status).toBe(200);
          const res = await request(app())
            .put(`${base(id)}/approvals/${approvals["REQ-2"]}`)
            .set("Authorization", `Bearer ${tokenFor(role)}`)
            .send({ status: "approved" });

          expect(res.status).toBe(200);
          expect(res.body.data.promotion).toEqual({ status: "promoted", requirementCount: 1 });
          expect(await promoted(id)).toEqual([
            ["REQ-1", "approved"],
            ["REQ-2", promotesAs],
          ]);
        });
      }
    });
  },
);
