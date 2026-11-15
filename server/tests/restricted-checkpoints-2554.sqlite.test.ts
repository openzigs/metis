/**
 * #2554 — a member a document's access list leaves out cannot decide, re-run,
 * cancel or ask for a review of what rests on that document, nor start an
 * analysis from it. A REAL SQLite database built by the migration chain, the
 * REAL routers and real JWTs.
 *
 * Fixture: one project with an open brief and `PAYROLL`, restricted to Alice.
 * Alice's change request `RUN` read the payroll document (a starter run): one
 * of its reviewed entries was promoted into a requirement resting on the
 * payroll document, one into a requirement resting on the brief, and one is
 * not promoted yet (it rests on the run as a whole), as does its evidence
 * checkpoint. `OPEN_RUN` read only the brief. Readers:
 *   - Bob, a member of the same workspace and role: every checkpoint of `RUN`
 *     except the brief's is restricted to him, and `RUN` as a whole is;
 *   - Alice, on the list, and Root, an admin: nothing is restricted.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisOrchestrator } from "../src/lib/analysis/index.js";
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
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));
const triggerSpy = vi.hoisted(() => vi.fn(async () => ({ id: "ia-2554", status: "pending" })));
vi.mock("../src/lib/impact-analysis/impact-analysis-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/impact-analysis/impact-analysis-engine.js")
  >("../src/lib/impact-analysis/impact-analysis-engine.js");
  return { ...actual, triggerImpactAnalysis: triggerSpy };
});

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { projectReviewsRouter } = await import("../src/routes/reviews.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-2554";
const P = "proj-2554-x"; // ids are at least 10 characters (`idSchema`)
const BRIEF = "doc-brief-2554";
const PAYROLL = "doc-payroll-2554";
const RUN = "run-2554-alice";
const OPEN_RUN = "run-2554-open";
const REQ_SECRET = "req-2554-payroll";
const REQ_OPEN = "req-2554-brief";
/** RUN's checkpoints: on the payroll requirement, the brief one, an unpromoted entry, evidence. */
const AP_SECRET = "ap-2554-secret";
const AP_OPEN = "ap-2554-open";
const AP_NEW = "ap-2554-new";
const AP_EVIDENCE = "ap-2554-evidence";
/** OPEN_RUN's one checkpoint, on an unpromoted entry: it rests on a run Bob can see. */
const AP_OPEN_RUN = "ap-2554-openrun";
const RUN_APPROVALS = [AP_SECRET, AP_OPEN, AP_NEW, AP_EVIDENCE];
/** A run whose one source document was deleted since: no one sees it as a whole. */
const GONE_RUN = "run-2554-gone";
const AP_GONE_RUN = "ap-2554-gonerun";

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, RoleKey> = { alice: "coordinator", bob: "coordinator", root: "admin" };
const sources = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });
/** A reviewed list whose every entry the run added (no ticked item restates one). */
const reviewedList = (ids: string[]) => ({
  requirements: ids.map((id) => ({
    id,
    type: "functional",
    priority: "medium",
    title: `Entry ${id}`,
    description: `Entry ${id} text`,
    stakeholders: [],
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  })),
});
const TICKED = [
  {
    candidateId: "NR-1",
    requirementId: "imp-2554-1",
    title: "Quarterly zebra migration",
    externalSource: "jira",
  },
];

const orch = {
  start: vi.fn(async () => ({ id: "run-2554-started" })),
  cancel: vi.fn(async () => true),
  assertCanRegenerate: vi.fn(async () => undefined),
  regenerateAgent: vi.fn(async () => undefined),
  assertCanResumeRepos: vi.fn(async () => ({ skippedRepos: ["repo-a"] })),
  resumeSkippedRepos: vi.fn(async () => undefined),
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2554 — a non-reader decides, re-runs and starts nothing resting on a document they cannot read (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: ROLES[who],
      permissions: getPermissionsForRole(ROLES[who]),
      workspaces: [WS],
    });
    const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;
    const app = () => {
      const a = express();
      a.use(express.json());
      const analysis = initAnalysisRouter({
        orchestrator: orch as unknown as AnalysisOrchestrator,
      });
      a.use("/api/projects/:projectId/analyses", analysis.projectScoped);
      a.use("/api/analyses", analysis.topLevel);
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use("/api/projects/:projectId/reviews", projectReviewsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (who: Who, path: string) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const post = (who: Who, path: string, body: object = {}) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const put = (who: Who, path: string, body: object) =>
      request(app()).put(path).set("Authorization", bearer(who)).send(body);
    const approvals = `/api/projects/${P}/analyses`;
    const deniedActions = () =>
      vi
        .mocked(audit)
        .mock.calls.map(([e]) => e.action)
        .filter((a) => a.endsWith(".denied"));
    const pendingOf = async (ids: string[]) =>
      (
        await db.approvalRequest.findMany({
          where: { id: { in: ids }, status: "pending", reviewerId: null },
        })
      ).length;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2554-restricted-checkpoints");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "w", slug: WS } });
      for (const key of ["coordinator", "admin"] as const) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const who of Object.keys(ROLES) as Who[]) {
        await db.user.create({
          data: { id: who, username: who, displayName: who, email: `${who}@example.test` },
        });
        await db.userRole.create({ data: { userId: who, roleId: `role-${ROLES[who]}` } });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: who, role: "member" } });
      }
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "alice", workspaceId: WS, status: "active" },
      });
      for (const [id, aclSubjects] of [
        [BRIEF, "[]"],
        [PAYROLL, JSON.stringify([{ kind: "user", value: "alice" }])],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename: `${id}.md`,
            mimeType: "text/markdown",
            sizeBytes: 2048,
            storagePath: `/tmp/${id}.md`,
            checksum: `sha-${id}`,
            uploadedById: "alice",
            status: "ready",
            chunkCount: 3,
            aclSubjects,
          },
        });
      }
      for (const [id, docs, entries] of [
        [RUN, [PAYROLL, BRIEF], ["s-secret", "s-open", "s-new"]],
        [OPEN_RUN, [BRIEF], ["s-openrun"]],
        [GONE_RUN, ["doc-deleted-2554"], ["s-gonerun"]],
      ] as const) {
        await db.analysis.create({
          data: {
            id,
            projectId: P,
            startedById: "alice",
            status: "completed",
            completedAt: new Date(),
            title: id,
            sourceAccess: "starter",
            metadata: JSON.stringify({
              agentKeys: ["document"],
              documentIds: docs,
              sourceRequirements: TICKED,
              structuredRequirements: reviewedList([...entries]),
            }),
          },
        });
        await db.agentResult.create({
          data: {
            analysisId: id,
            agentKey: "document",
            status: "completed",
            readSourceIds: sources([...docs]),
            output: JSON.stringify({ summary: "s", notes: [] }),
          },
        });
      }
      for (const [id, doc, structured] of [
        [REQ_SECRET, PAYROLL, "s-secret"],
        [REQ_OPEN, BRIEF, "s-open"],
      ] as const) {
        await db.requirement.create({
          data: {
            id,
            analysisId: RUN,
            projectId: P,
            title: `Requirement ${id}`,
            body: "b",
            labels: "[]",
            sourceIds: sources([doc]),
            promotedStructuredId: structured,
          },
        });
      }
      for (const [id, analysisId, type, itemId] of [
        [AP_SECRET, RUN, "requirement", "s-secret"],
        [AP_OPEN, RUN, "requirement", "s-open"],
        [AP_NEW, RUN, "requirement", "s-new"],
        [AP_EVIDENCE, RUN, "evidence", "ev-2554"],
        [AP_OPEN_RUN, OPEN_RUN, "requirement", "s-openrun"],
        [AP_GONE_RUN, GONE_RUN, "requirement", "s-gonerun"],
      ] as const) {
        await db.approvalRequest.create({ data: { id, analysisId, type, itemId } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.approvalRequest.updateMany({
        data: { status: "pending", reviewerId: null, reviewNote: null, reviewedAt: null },
      });
      // A decision that resolves a run's last checkpoint promotes its reviewed
      // list; what that wrote is not part of the fixture.
      await db.requirement.deleteMany({ where: { id: { notIn: [REQ_SECRET, REQ_OPEN] } } });
      vi.mocked(audit).mockClear();
      for (const fn of Object.values(orch)) fn.mockClear();
      triggerSpy.mockClear();
    });

    describe("A — the checkpoints of a run resting on a document Bob cannot read", () => {
      it("the approvals list marks each checkpoint whose entry Bob cannot see, and only those", async () => {
        const restrictedFor = async (who: Who) => {
          const res = await get(who, `${approvals}/${RUN}/approvals`);
          expect(res.status).toBe(200);
          return (res.body.data.items as Array<{ id: string; restricted?: true }>)
            .filter((a) => a.restricted)
            .map((a) => a.id)
            .sort();
        };
        expect(await restrictedFor("bob")).toEqual([AP_EVIDENCE, AP_NEW, AP_SECRET].sort());
        expect(await restrictedFor("alice")).toEqual([]);
        expect(await restrictedFor("root")).toEqual([]);
      });

      it("Bob's approve or reject of a checkpoint he cannot see is refused, audited, and changes nothing", async () => {
        for (const id of [AP_SECRET, AP_NEW, AP_EVIDENCE]) {
          for (const status of ["approved", "rejected"]) {
            const res = await put("bob", `${approvals}/${RUN}/approvals/${id}`, { status });
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe("CHECKPOINT_RESTRICTED");
          }
        }
        expect(await pendingOf(RUN_APPROVALS)).toBe(4);
        expect(deniedActions()).toEqual(Array(6).fill("analysis.approval.review.denied"));
        // An unknown approval is still the handler's own 404.
        const unknown = await put("bob", `${approvals}/${RUN}/approvals/ap-2554-nope`, {
          status: "approved",
        });
        expect(unknown.status).toBe(404);
        expect(unknown.body.error.code).toBe("APPROVAL_NOT_FOUND");
      });

      it("Bob decides the checkpoint he can see; Alice and Root decide the one he cannot", async () => {
        const bob = await put("bob", `${approvals}/${RUN}/approvals/${AP_OPEN}`, {
          status: "approved",
        });
        expect(bob.status).toBe(200);
        expect(bob.body.data).toMatchObject({ status: "approved", reviewerId: "bob" });
        for (const who of ["alice", "root"] as const) {
          const res = await put(who, `${approvals}/${RUN}/approvals/${AP_SECRET}`, {
            status: "rejected",
          });
          expect(res.status).toBe(200);
          await db.approvalRequest.update({
            where: { id: AP_SECRET },
            data: { status: "pending", reviewerId: null, reviewedAt: null },
          });
        }
        expect(deniedActions()).toEqual([]);
      });

      it("approve all is refused to Bob while a pending checkpoint is one he cannot see", async () => {
        const bob = await post("bob", `${approvals}/${RUN}/approvals/approve-all`);
        expect(bob.status).toBe(403);
        expect(bob.body.error.code).toBe("CHECKPOINT_RESTRICTED");
        expect(await pendingOf(RUN_APPROVALS)).toBe(4);
        expect(deniedActions()).toEqual(["analysis.approval.approve_all.denied"]);
        // A run whose every checkpoint he can see.
        const open = await post("bob", `${approvals}/${OPEN_RUN}/approvals/approve-all`);
        expect(open.status).toBe(200);
        expect(open.body.data.approvedCount).toBe(1);
        const alice = await post("alice", `${approvals}/${RUN}/approvals/approve-all`);
        expect(alice.status).toBe(200);
        expect(alice.body.data.approvedCount).toBe(4);
      });

      it("leaving out the added is refused to Bob while one of them is a checkpoint he cannot see", async () => {
        const bob = await post("bob", `${approvals}/${RUN}/approvals/reject-added`);
        expect(bob.status).toBe(403);
        expect(bob.body.error.code).toBe("CHECKPOINT_RESTRICTED");
        expect(await pendingOf(RUN_APPROVALS)).toBe(4);
        expect(deniedActions()).toEqual(["analysis.approval.reject_added.denied"]);
        const open = await post("bob", `${approvals}/${OPEN_RUN}/approvals/reject-added`);
        expect(open.status).toBe(200);
        expect(open.body.data.rejectedCount).toBe(1);
        const alice = await post("alice", `${approvals}/${RUN}/approvals/reject-added`);
        expect(alice.status).toBe(200);
        expect(alice.body.data.rejectedCount).toBe(3);
      });

      it("Bob cannot reopen a rejected checkpoint he cannot see", async () => {
        await db.approvalRequest.updateMany({
          where: { id: { in: [AP_SECRET, AP_OPEN] } },
          data: { status: "rejected", reviewerId: "alice", reviewedAt: new Date() },
        });
        const bob = await post("bob", `${approvals}/${RUN}/approvals/${AP_SECRET}/reopen`);
        expect(bob.status).toBe(403);
        expect(bob.body.error.code).toBe("CHECKPOINT_RESTRICTED");
        expect(
          (await db.approvalRequest.findUniqueOrThrow({ where: { id: AP_SECRET } })).status,
        ).toBe("rejected");
        expect(deniedActions()).toEqual(["analysis.approval.reopen.denied"]);
        expect((await post("bob", `${approvals}/${RUN}/approvals/${AP_OPEN}/reopen`)).status).toBe(
          200,
        );
        expect(
          (await post("alice", `${approvals}/${RUN}/approvals/${AP_SECRET}/reopen`)).status,
        ).toBe(200);
      });
    });

    describe("A — run-wide actions on a run Bob cannot see in full", () => {
      it("the snapshot says the run is restricted to Bob, and to no one else", async () => {
        expect((await get("bob", `/api/analyses/${RUN}`)).body.data.runRestricted).toBe(true);
        expect((await get("alice", `/api/analyses/${RUN}`)).body.data).not.toHaveProperty(
          "runRestricted",
        );
        expect((await get("bob", `/api/analyses/${OPEN_RUN}`)).body.data).not.toHaveProperty(
          "runRestricted",
        );
      });

      it("Regenerate, Cancel and resume are refused to Bob before anything runs, and audited", async () => {
        const regen = await post("bob", `/api/analyses/${RUN}/agents/document/regenerate`);
        const cancel = await post("bob", `/api/analyses/${RUN}/cancel`);
        const resume = await post("bob", `/api/analyses/${RUN}/resume-repos`);
        for (const res of [regen, cancel, resume]) {
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("ANALYSIS_RESTRICTED");
        }
        expect(orch.assertCanRegenerate).not.toHaveBeenCalled();
        expect(orch.regenerateAgent).not.toHaveBeenCalled();
        expect(orch.cancel).not.toHaveBeenCalled();
        expect(orch.assertCanResumeRepos).not.toHaveBeenCalled();
        expect(deniedActions()).toEqual([
          "analysis.regenerate.denied",
          "analysis.cancel.denied",
          "analysis.resume_repos.denied",
        ]);
      });

      it("Alice, and Bob on a run he can see in full, still regenerate, cancel and resume", async () => {
        for (const [who, run] of [
          ["alice", RUN],
          ["bob", OPEN_RUN],
        ] as const) {
          expect((await post(who, `/api/analyses/${run}/agents/document/regenerate`)).status).toBe(
            202,
          );
          expect((await post(who, `/api/analyses/${run}/cancel`)).status).toBe(200);
          expect((await post(who, `/api/analyses/${run}/resume-repos`)).status).toBe(202);
        }
        expect(orch.regenerateAgent).toHaveBeenCalledTimes(2);
        expect(orch.cancel).toHaveBeenCalledTimes(2);
        expect(deniedActions()).toEqual([]);
      });

      it("a review of a requirement Bob cannot see is refused; one of what he can see is not", async () => {
        const ask = (who: Who, requirementId: string) =>
          post(who, `/api/projects/${P}/reviews`, {
            title: "Sign off",
            reviewerIds: ["root"],
            items: [{ requirementId }],
          });
        const before = await db.reviewRequest.count();
        const bob = await ask("bob", REQ_SECRET);
        expect(bob.status).toBe(403);
        expect(bob.body.error.code).toBe("REVIEW_ITEM_RESTRICTED");
        expect(await db.reviewRequest.count()).toBe(before);
        expect(deniedActions()).toEqual(["review.create.denied"]);
        expect((await ask("bob", REQ_OPEN)).status).toBe(201);
        expect((await ask("alice", REQ_SECRET)).status).toBe(201);
        // An id of no requirement here is still the item resolution's 404.
        expect((await ask("bob", "req-2554-nope")).status).toBe(404);
      });
    });

    describe("a run whose source document was deleted since", () => {
      it("is refused to its own starter, and an admin still decides and re-runs it", async () => {
        const restricted = async (who: Who) =>
          (
            (await get(who, `${approvals}/${GONE_RUN}/approvals`)).body.data.items as Array<{
              restricted?: true;
            }>
          ).some((a) => a.restricted);
        expect(await restricted("alice")).toBe(true);
        expect(await restricted("root")).toBe(false);
        expect((await get("alice", `/api/analyses/${GONE_RUN}`)).body.data.runRestricted).toBe(
          true,
        );
        expect((await get("root", `/api/analyses/${GONE_RUN}`)).body.data).not.toHaveProperty(
          "runRestricted",
        );
        const decide = (who: Who) =>
          put(who, `${approvals}/${GONE_RUN}/approvals/${AP_GONE_RUN}`, { status: "approved" });
        expect((await decide("alice")).status).toBe(403);
        expect((await post("alice", `/api/analyses/${GONE_RUN}/cancel`)).status).toBe(403);
        expect((await decide("root")).status).toBe(200);
        expect((await post("root", `/api/analyses/${GONE_RUN}/cancel`)).status).toBe(200);
        expect(orch.cancel).toHaveBeenCalledTimes(1);
      });
    });

    describe("B — starting an analysis from a document Bob cannot read", () => {
      it("answers 404, as for an unknown document, before the run starts", async () => {
        for (const documentIds of [[PAYROLL], [BRIEF, PAYROLL]]) {
          const res = await post("bob", approvals, { documentIds });
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe("NOT_FOUND");
          expect(JSON.stringify(res.body)).not.toContain(PAYROLL);
        }
        expect(orch.start).not.toHaveBeenCalled();
        expect(deniedActions()).toEqual(["analysis.document.denied", "analysis.document.denied"]);
      });

      it("a document Bob can read, and Alice's own, still start", async () => {
        expect((await post("bob", approvals, { documentIds: [BRIEF] })).status).toBe(202);
        expect((await post("alice", approvals, { documentIds: [PAYROLL] })).status).toBe(202);
        expect((await post("root", approvals, { documentIds: [PAYROLL] })).status).toBe(202);
        expect(orch.start).toHaveBeenCalledTimes(3);
      });
    });

    describe("an impact analysis of a requirement Bob cannot see", () => {
      it("answers the requirement's not-found, not the projects' refusal, and is audited", async () => {
        const bob = await post("bob", "/api/impact-analyses", {
          requirementIds: [REQ_SECRET],
          projectIds: [P],
        });
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
        expect(bob.body.error.message).not.toMatch(/project/i);
        expect(triggerSpy).not.toHaveBeenCalled();
        expect(deniedActions()).toEqual(["impact_analysis.requirement.denied"]);
        const alice = await post("alice", "/api/impact-analyses", {
          requirementIds: [REQ_SECRET],
          projectIds: [P],
        });
        expect(alice.status).toBe(202);
      });
    });
  },
);
