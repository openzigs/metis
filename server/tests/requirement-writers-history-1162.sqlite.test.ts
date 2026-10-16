/**
 * #1162 — every writer of a requirement is honest about the version history.
 *
 * A review pinned at version N is shown by reversing the recorded changes from
 * the current row (#1130), so a writer that changes a tracked field without a
 * version row makes the "pinned" text include changes the reviewer never saw.
 * Clarification enrichment (`body`) and import re-sync (`title`, `body`,
 * `priority`, `type`, `labels`) did exactly that. Review status writes did too,
 * and the decision there is the opposite one: `reviewStatus` is no longer a
 * tracked field, so a review's own transitions must leave the version alone.
 *
 * Proven through the real writers against a real SQLite database built from
 * the migration chain; only notifications, audit, and the source API are faked.
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
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit,
}));
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));

const { applyClarificationsToRequirements, CLARIFICATION_VERSION_REASON } =
  await import("../src/lib/analysis/clarification-enrichment.js");
const { ImportService, IMPORT_RESYNC_VERSION_REASON } =
  await import("../src/lib/importers/import-service.js");
const { createReviewRequest, submitReview, recordDecision } =
  await import("../src/lib/reviews/review-service.js");
const { originalVersionOf, pickTracked } =
  await import("../src/lib/requirements/requirement-version-service.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const PROJECT = "proj-1162";
const ANALYSIS = "ana-1162";
const REQUESTER = "u-1162-req";
const REVIEWER = "u-1162-rev";

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1162 — requirement writers and version history",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const makeRequirement = async (data: Record<string, unknown> = {}) => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-1162-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          ...data,
        },
      });
      return row.id;
    };

    const versionsOf = (requirementId: string) =>
      db.requirementVersion.findMany({ where: { requirementId }, orderBy: { version: "desc" } });

    /** The text a review pinned at `version` shows, rebuilt exactly as the API does. */
    const pinnedBodyAt = async (requirementId: string) => {
      const row = await db.requirement.findUniqueOrThrow({ where: { id: requirementId } });
      const rows = await versionsOf(requirementId);
      return originalVersionOf(pickTracked(row), row.version, rows);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1162-writers-history");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [REQUESTER, REVIEWER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1162", name: "ws", slug: "ws-1162" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1162", userId: REQUESTER, role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: REQUESTER,
          workspaceId: "ws-1162",
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("clarification enrichment records its body write, so version 0 still shows the original text", async () => {
      const id = await makeRequirement({ title: "Multi-currency price display" });
      await db.analysis.update({
        where: { id: ANALYSIS },
        data: {
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [
                {
                  id: "REQ-1",
                  title: "Multi-currency price display",
                  description: "",
                  type: "functional",
                  stakeholders: [],
                  priority: "must-have",
                  ambiguities: [],
                  evidenceNeeds: [],
                  rawSource: "",
                },
              ],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
          }),
        },
      });
      await db.clarificationDialogState.create({
        data: {
          analysisId: ANALYSIS,
          state: JSON.stringify({
            analysisId: ANALYSIS,
            currentRound: 1,
            maxRounds: 3,
            rounds: [
              {
                round: 1,
                questions: [
                  {
                    id: "q1",
                    requirementId: "REQ-1",
                    ambiguityField: "rateSource",
                    question: "Which rate source?",
                    context: "",
                    answer: "The ECB daily rate.",
                  },
                ],
                answers: [],
              },
            ],
            resolvedAmbiguities: [],
            escalatedToSonnet: false,
            completed: true,
          }),
        },
      });

      const out = await applyClarificationsToRequirements(ANALYSIS);

      expect(out).toMatchObject({ requirementsUpdated: 1 });
      const row = await db.requirement.findUniqueOrThrow({ where: { id } });
      expect(row.body).toContain("The ECB daily rate.");
      expect(row.version).toBe(1);
      const [v1] = await versionsOf(id);
      expect(v1).toMatchObject({ version: 1, reason: CLARIFICATION_VERSION_REASON });
      expect(await pinnedBodyAt(id)).toMatchObject({
        version: 0,
        source: "reversed",
        snapshot: { body: "The original body" },
      });
    });

    it("import re-sync records an upstream change, so the pinned text is the text before the sync", async () => {
      const issues = [
        {
          number: 7,
          title: "Export orders",
          body: "As imported",
          html_url: "https://github.com/o/r/issues/7",
          state: "open",
          labels: [],
        },
      ];
      const source = await db.importSource.create({
        data: {
          projectId: PROJECT,
          analysisId: ANALYSIS,
          source: "github",
          label: "GH",
          filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
          secretId: "secret_1",
          createdById: REQUESTER,
        },
      });
      const svc = new ImportService({
        prisma: db,
        vault: {
          create: vi.fn(),
          read: vi.fn(async () => ({ summary: {} as never, plaintext: "tok" })),
          delete: vi.fn(),
        },
        enqueueTask: vi.fn(async () => ({ id: "task_1" })),
        createScheduledJob: vi.fn(async () => ({ id: "job_1" })),
        deleteScheduledJob: vi.fn(async () => undefined),
        resolveJira: vi.fn(),
        importerDeps: {
          fetchFn: vi.fn(async (url: string | URL | Request) =>
            String(url).includes("/graphql")
              ? res(200, { data: { search: { issueCount: issues.length } } })
              : res(200, issues),
          ),
          assertHostAllowed: () => undefined,
          backoff: { sleep: async () => undefined, now: () => 0, random: () => 0 },
        },
      });

      const first = await svc.runSource(source.id, { trigger: "manual" });
      expect(first).toMatchObject({ status: "completed", createdCount: 1 });
      const imported = await db.requirement.findFirstOrThrow({
        where: { importSourceId: source.id },
      });
      expect(imported.version).toBe(0);

      // An unchanged re-sync records nothing.
      await svc.runSource(source.id, { trigger: "manual" });
      expect(await versionsOf(imported.id)).toHaveLength(0);

      issues[0] = { ...issues[0], title: "Export orders as CSV", body: "Changed upstream" };
      const third = await svc.runSource(source.id, { trigger: "manual" });

      expect(third).toMatchObject({ status: "completed", updatedCount: 1 });
      const row = await db.requirement.findUniqueOrThrow({ where: { id: imported.id } });
      expect(row).toMatchObject({ title: "Export orders as CSV", version: 1 });
      const [v1] = await versionsOf(imported.id);
      expect(v1.reason).toBe(IMPORT_RESYNC_VERSION_REASON);
      expect(Object.keys(JSON.parse(v1.changedFields)).sort()).toEqual(["body", "title"]);
      expect(await pinnedBodyAt(imported.id)).toMatchObject({
        version: 0,
        snapshot: { title: "Export orders", body: "As imported" },
      });
    });

    it("a review's own status writes leave the version it pinned as the current one", async () => {
      const id = await makeRequirement({ version: 3, reviewStatus: null });
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: [{ requirementId: id }],
      })) as { id: string };

      await submitReview(REQUESTER, created.id, false);
      expect(await db.requirement.findUniqueOrThrow({ where: { id } })).toMatchObject({
        reviewStatus: "draft",
        version: 3,
      });
      await recordDecision(REVIEWER, created.id, "approved");

      const row = await db.requirement.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ reviewStatus: "approved", version: 3 });
      expect(await versionsOf(id)).toHaveLength(0);
      const item = await db.reviewRequestItem.findFirstOrThrow({
        where: { reviewRequestId: created.id },
      });
      expect(item.pinnedVersion).toBe(row.version);
    });

    describe("PUT /api/requirements/:id — a manual status change", () => {
      const app = () => {
        const a = express();
        a.use(express.json());
        a.use("/api/requirements", requirementsCollaborationRouter());
        a.use("/api/analyses", initAnalysisRouter().topLevel);
        a.use(notFoundHandler);
        a.use(errorHandler);
        return a;
      };
      const token = () =>
        issueTokens({
          userId: REQUESTER,
          username: REQUESTER,
          role: "admin",
          permissions: [],
          workspaces: ["ws-1162"],
        }).accessToken;

      it("is written and audited without minting a version", async () => {
        const id = await makeRequirement({ version: 2, reviewStatus: "draft" });
        audit.mockClear();

        const r = await request(app())
          .put(`/api/requirements/${id}`)
          .set("Authorization", `Bearer ${token()}`)
          .send({ reviewStatus: "approved", version: 2 });

        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ version: 2 });
        expect(await db.requirement.findUniqueOrThrow({ where: { id } })).toMatchObject({
          reviewStatus: "approved",
          version: 2,
        });
        expect(await versionsOf(id)).toHaveLength(0);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "requirement.review_status.set",
            target: { type: "requirement", id },
            metadata: { from: "draft", to: "approved" },
          }),
        );
      });

      it("a content edit alongside it is versioned on its own, the status left out", async () => {
        const id = await makeRequirement({ version: 0, reviewStatus: null });

        const r = await request(app())
          .put(`/api/requirements/${id}`)
          .set("Authorization", `Bearer ${token()}`)
          .send({ title: "Renamed", reviewStatus: "approved", version: 0 });

        expect(r.status).toBe(200);
        const [v1] = await versionsOf(id);
        expect(JSON.parse(v1.changedFields)).toEqual({
          title: { from: expect.any(String), to: "Renamed" },
        });
        expect(await db.requirement.findUniqueOrThrow({ where: { id } })).toMatchObject({
          reviewStatus: "approved",
          version: 1,
        });
      });

      it("PATCH /api/analyses/:id/requirements/:reqId (approve on the Analysis page) is audited with its from/to, unversioned", async () => {
        const id = await makeRequirement({ version: 1, reviewStatus: "draft" });
        audit.mockClear();

        const r = await request(app())
          .patch(`/api/analyses/${ANALYSIS}/requirements/${id}`)
          .set("Authorization", `Bearer ${token()}`)
          .send({ reviewStatus: "approved", version: 1 });

        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ version: 1 });
        expect(await versionsOf(id)).toHaveLength(0);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "analysis.requirement.update",
            metadata: expect.objectContaining({
              reviewStatus: { from: "draft", to: "approved" },
            }),
          }),
        );
      });

      it("does not audit a status that did not change", async () => {
        const id = await makeRequirement({ version: 0, reviewStatus: "approved" });
        audit.mockClear();
        const r = await request(app())
          .put(`/api/requirements/${id}`)
          .set("Authorization", `Bearer ${token()}`)
          .send({ reviewStatus: "approved", version: 0 });
        expect(r.status).toBe(200);
        expect(audit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "requirement.review_status.set" }),
        );
      });
    });
  },
);
