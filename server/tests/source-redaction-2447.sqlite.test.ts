/**
 * #2447 (epic #2438) — redact on read, on every surface that shows analysis
 * output, per role, over a REAL SQLite database built by the migration chain
 * and (where the surface is a route) the REAL router with real JWTs.
 *
 * Fixture: one project, two documents (`d-open`, and `d-secret` restricted to
 * Alice). Run `CR` was written under the shared audience (`sourceAccess =
 * shared`, #2446), with a finding, a requirement and a cross-document finding
 * on each document, and a requirement with no record (it rests on the run).
 * Run `LEGACY` is from before #2446 (no marker): its rows cite `d-secret` and
 * keep the shared-audience rule. Readers:
 *   - Alice, named on the access list: sees everything;
 *   - Bob, a member of the same workspace and role: every row resting on
 *     `d-secret` is the "Restricted" placeholder, nothing else is;
 *   - Root, an admin: sees everything (the access-list bypass);
 *   - the shared audience (Spec Kit): sees nothing restricted.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  RESTRICTED_SOURCE_TITLE,
  type AnalysisSnapshot,
  type AuthPayload,
  type RoleKey,
} from "@metis/shared";
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
// Every requirement is the nearest to anything and embeds to one vector, so which
// ones a reader is told of is decided by the redaction alone.
vi.mock("../src/lib/requirements/requirement-embeddings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/requirements/requirement-embeddings.js")>();
  return {
    ...actual,
    findNearestRequirements: async (projectId: string) =>
      (
        await (state.db as PrismaClient).requirement.findMany({
          where: { projectId, deletedAt: null },
          select: { id: true },
        })
      ).map((r) => ({ requirementId: r.id, score: 0.99 })),
  };
});
vi.mock("../src/lib/rag/embedder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({
    model: "stub",
    embed: async (t: string[]) => ({ vectors: t.map(() => [1, 0]) }),
  }),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));
const triggerSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/impact-analysis/impact-analysis-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/impact-analysis/impact-analysis-engine.js")
  >("../src/lib/impact-analysis/impact-analysis-engine.js");
  return { ...actual, triggerImpactAnalysis: triggerSpy };
});

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { projectRequirementsRouter } = await import("../src/routes/project-requirements.js");
const { requirementSimilarityRouter } = await import("../src/routes/requirement-similarity.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { discussionsRouter } = await import("../src/routes/discussions.js");
const { traceabilityRouter } = await import("../src/routes/traceability.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getAnalysisSnapshot, loadFindingForDeepDive } =
  await import("../src/lib/analysis/analysis-service.js");
const { userSourceReader, sharedSourceReader } =
  await import("../src/lib/analysis/source-redaction.js");
const { loadChangeRequestSource, restrictedNotChecked } =
  await import("../src/lib/analysis/change-request-source.js");
const { visibleTitleMatches } =
  await import("../src/lib/requirements/project-requirements-list.js");
const { loadApprovedRequirements, SpecKitRequirementSeedError } =
  await import("../src/lib/spec-kit/requirements-seed.js");
const { loadReadableSourceRequirement } = await import("../src/lib/portfolio/gap-engine.js");
const { resolveChatSubject } = await import("../src/lib/ai/chat-subject.js");
const { createGetAnalysisTool } = await import("../src/lib/analysis/results-chat-tools.js");
const { createGetRequirementTool, createListRequirementsTool } =
  await import("../src/lib/requirements/requirements-chat-tools.js");
const { getRequirementDiff } =
  await import("../src/lib/change-analysis/requirement-diff-service.js");

const WS = "ws-2447";
const P = "proj-2447-x";
const CR = "cr-2447-shared";
const LEGACY = "cr-2447-legacy";
const SECRET = "Payroll export for the CFO";

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, RoleKey> = { alice: "coordinator", bob: "coordinator", root: "admin" };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2447 — every surface redacts what the reader cannot see a source of (real SQLite)",
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
      const analysis = initAnalysisRouter();
      a.use("/api/projects/:projectId/analyses", analysis.projectScoped);
      a.use("/api/projects/:projectId/requirements", requirementSimilarityRouter());
      a.use("/api/projects/:projectId/requirements", projectRequirementsRouter());
      a.use("/api/analyses", analysis.topLevel);
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use("/api/discussions", discussionsRouter());
      a.use("/api/projects/:projectId", traceabilityRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (who: Who, path: string) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const sources = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2447-source-redaction");
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
        ["d-open", "[]"],
        ["d-secret", JSON.stringify([{ kind: "user", value: "alice" }])],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename: `${id}.md`,
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: "alice",
            status: "ready",
            aclSubjects,
          },
        });
      }
      for (const [id, sourceAccess, title] of [
        [CR, "shared", "Checkout"],
        [LEGACY, null, "Older checkout"],
      ] as const) {
        await db.analysis.create({
          data: {
            id,
            projectId: P,
            startedById: "alice",
            status: "completed",
            completedAt: new Date(),
            title,
            sourceAccess,
          },
        });
      }
      const finding = (id: string, title: string, sourceIds: string | null) => ({
        id,
        category: "security",
        severity: "high",
        title,
        body: `${title} — body`,
        evidence: JSON.stringify({
          citations: [{ kind: "document", documentId: "d-secret", chunkIndex: 0, quote: title }],
          tags: ["payroll"],
        }),
        sourceIds,
      });
      await db.agentResult.create({
        data: {
          analysisId: CR,
          agentKey: "code",
          status: "completed",
          output: JSON.stringify({ summary: "Read the documents", notes: [] }),
          findings: {
            create: [
              finding("f-open", "Checkout keeps a cart", sources(["d-open"])),
              finding("f-secret", SECRET, sources(["d-secret"])),
            ],
          },
        },
      });
      await db.agentResult.create({
        data: {
          analysisId: LEGACY,
          agentKey: "code",
          status: "completed",
          findings: { create: [finding("f-legacy", `${SECRET} (legacy)`, null)] },
        },
      });
      const requirement = (
        id: string,
        analysisId: string,
        title: string,
        sourceIds: string | null,
      ) =>
        db.requirement.create({
          data: {
            id,
            analysisId,
            projectId: P,
            title,
            body: `${title} — body`,
            reviewStatus: "approved",
            labels: JSON.stringify(["payroll"]),
            acceptanceCriteria: JSON.stringify([`${title} works`]),
            sourceIds,
          },
        });
      await requirement("req-2447-open", CR, "Customers can pay", sources(["d-open"]));
      await requirement("req-2447-secret", CR, SECRET, sources(["d-secret"]));
      // The reviewed list the approvals panel renders and promotion copies the
      // text from: the same title and description as the rows it became.
      const entry = (id: string, title: string) => ({
        id,
        title,
        description: `${title} — description`,
        type: "functional",
        stakeholders: [],
        priority: "must",
        ambiguities: [],
        evidenceNeeds: [],
        rawSource: `${title} — raw`,
      });
      await db.requirement.update({
        where: { id: "req-2447-open" },
        data: { promotedStructuredId: "s-open" },
      });
      await db.requirement.update({
        where: { id: "req-2447-secret" },
        data: { promotedStructuredId: "s-secret" },
      });
      await db.analysis.update({
        where: { id: CR },
        data: {
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [
                entry("s-open", "Customers can pay"),
                entry("s-secret", SECRET),
                entry("s-new", "Not yet promoted"),
              ],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
          }),
        },
      });
      await requirement("req-2447-run", CR, "Checkout is fast", null);
      await requirement("req-2447-legacy", LEGACY, `${SECRET} (legacy)`, sources(["d-secret"]));
      await db.crossDocFinding.createMany({
        data: [
          {
            id: "c-secret",
            analysisId: CR,
            kind: "contradiction",
            title: SECRET,
            detail: `${SECRET} contradicts the cart`,
            sourceIds: sources(["d-secret"]),
          },
          {
            id: "c-open",
            analysisId: CR,
            kind: "contradiction",
            title: "Cart rules differ",
            detail: "Two documents disagree",
            sourceIds: sources(["d-open"]),
          },
        ],
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      triggerSpy.mockReset();
      triggerSpy.mockImplementation(async () => ({ id: "ia-2447", status: "pending" }));
    });

    const restrictedIdsOf = (snapshot: AnalysisSnapshot) => ({
      findings: snapshot.agents
        .flatMap((a) => a.findings)
        .filter((f) => f.restricted)
        .map((f) => f.id),
      requirements: snapshot.requirements.filter((r) => r.restricted).map((r) => r.id),
      crossDoc: (snapshot.crossDocFindings?.findings ?? [])
        .filter((f) => f.restricted)
        .map((f) => f.id),
    });

    describe("similar requirements (a search that would probe a hidden requirement)", () => {
      const base = `/api/projects/${P}/requirements`;
      const titles = (res: { body: { data: { items: Array<{ title: string }> } } }) =>
        res.body.data.items.map((i) => i.title);
      const post = (who: Who, path: string, body: object) =>
        request(app()).post(path).set("Authorization", bearer(who)).send(body);

      it("never finds the restricted requirement for Bob, by its title or its body", async () => {
        for (const text of ["Payroll export for the CFO", "works"]) {
          const res = await post("bob", `${base}/similar`, { text });
          expect(res.status).toBe(200);
          // (The pre-#2446 run's row keeps the shared-audience rule, by design.)
          expect(titles(res)).not.toContain(SECRET);
          expect(JSON.stringify(res.body)).not.toContain("req-2447-secret");
          expect(res.body.data.items.length).toBeGreaterThan(0);
        }
      });

      it("still finds it for Alice (on the list) and the admin", async () => {
        for (const who of ["alice", "root"] as const) {
          const res = await post(who, `${base}/similar`, { text: "Payroll export", limit: 20 });
          expect(titles(res)).toContain(SECRET);
        }
      });

      it("gives Bob no neighbours of a restricted id, and Alice hers", async () => {
        const bob = await get("bob", `${base}/req-2447-secret/similar`);
        expect(bob.status).toBe(404);
        const alice = await get("alice", `${base}/req-2447-secret/similar`);
        expect(alice.status).toBe(200);
        // Bob asking about a requirement he can open is not told of it.
        const open = await get("bob", `${base}/req-2447-open/similar?limit=20`);
        expect(open.status).toBe(200);
        expect(JSON.stringify(open.body)).not.toContain("req-2447-secret");
      });

      it("refuses Bob a write to, or a borrow from, a restricted requirement", async () => {
        const borrowInto = await post("bob", `${base}/req-2447-secret/borrow-citations`, {
          fromRequirementId: "req-2447-open",
        });
        const borrowFrom = await post("bob", `${base}/req-2447-open/borrow-citations`, {
          fromRequirementId: "req-2447-secret",
        });
        const dismiss = await post(
          "bob",
          `${base}/req-2447-open/similar/req-2447-secret/not-duplicate`,
          {},
        );
        expect([borrowInto.status, borrowFrom.status, dismiss.status]).toEqual([404, 404, 404]);
      });
    });

    describe("the result page and change request (GET /api/analyses/:id)", () => {
      it("redacts, for Bob, exactly the rows resting on the restricted document", async () => {
        const res = await get("bob", `/api/analyses/${CR}`);
        expect(res.status).toBe(200);
        const snapshot = res.body.data as AnalysisSnapshot;
        expect(restrictedIdsOf(snapshot)).toEqual({
          findings: ["f-secret"],
          requirements: ["req-2447-secret"],
          crossDoc: ["c-secret"],
        });
        // Never the whole result: every row is still there, in place.
        expect(snapshot.agents[0]!.findings.map((f) => f.id)).toEqual(["f-open", "f-secret"]);
        expect(snapshot.requirements.map((r) => r.id).sort()).toEqual([
          "req-2447-open",
          "req-2447-run",
          "req-2447-secret",
        ]);
        const secret = snapshot.requirements.find((r) => r.id === "req-2447-secret")!;
        expect(secret).toMatchObject({ title: RESTRICTED_SOURCE_TITLE, acceptanceCriteria: [] });
        expect(JSON.stringify(res.body)).not.toContain("Payroll");
        // The reviewed list in `metadata` is redacted with the row it became.
        const listed = (
          snapshot.metadata!.structuredRequirements as {
            requirements: Array<{ id: string; title: string; restricted?: boolean }>;
          }
        ).requirements;
        expect(listed.map((r) => [r.id, r.title, r.restricted ?? false])).toEqual([
          ["s-open", "Customers can pay", false],
          ["s-secret", RESTRICTED_SOURCE_TITLE, true],
          ["s-new", "Not yet promoted", false],
        ]);
        // The run's narrative rests on the shared audience Bob is part of.
        expect(snapshot.agents[0]!.summary).toBe("Read the documents");
      });

      it("shows Alice (on the list) and an admin everything", async () => {
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/analyses/${CR}`);
          expect(res.status).toBe(200);
          expect(restrictedIdsOf(res.body.data)).toEqual({
            findings: [],
            requirements: [],
            crossDoc: [],
          });
          expect(JSON.stringify(res.body)).toContain(SECRET);
        }
      });

      it("keeps the shared-audience rule for a run from before #2446", async () => {
        const res = await get("bob", `/api/analyses/${LEGACY}`);
        expect(res.status).toBe(200);
        expect(restrictedIdsOf(res.body.data)).toEqual({
          findings: [],
          requirements: [],
          crossDoc: [],
        });
      });

      it("follows the access list as it is now, not as it was at the run", async () => {
        await db.document.update({
          where: { id: "d-secret" },
          data: { aclSubjects: JSON.stringify([{ kind: "user", value: "bob" }]) },
        });
        try {
          const alice = await get("alice", `/api/analyses/${CR}`);
          const bob = await get("bob", `/api/analyses/${CR}`);
          expect(restrictedIdsOf(alice.body.data).findings).toEqual(["f-secret"]);
          expect(restrictedIdsOf(bob.body.data).findings).toEqual([]);
        } finally {
          await db.document.update({
            where: { id: "d-secret" },
            data: { aclSubjects: JSON.stringify([{ kind: "user", value: "alice" }]) },
          });
        }
      });

      it("treats a reader who is no longer active as seeing nothing restricted", async () => {
        await db.user.update({ where: { id: "alice" }, data: { status: "inactive" } });
        try {
          const snapshot = await getAnalysisSnapshot(CR, { reader: userSourceReader("alice") });
          expect(restrictedIdsOf(snapshot!).findings).toEqual(["f-secret"]);
        } finally {
          await db.user.update({ where: { id: "alice" }, data: { status: "active" } });
        }
      });
    });

    describe("exports", () => {
      it("the analysis report leaves out the restricted rows' text for Bob only", async () => {
        const bob = await get("bob", `/api/projects/${P}/analyses/${CR}/export`);
        const alice = await get("alice", `/api/projects/${P}/analyses/${CR}/export`);
        expect(bob.status).toBe(200);
        expect(alice.status).toBe(200);
        expect(bob.text).not.toContain("Payroll");
        expect(bob.text).toContain("Customers can pay");
        expect(alice.text).toContain(SECRET);
      });

      it("the traceability CSV and the gap report do too", async () => {
        const csv = await get("bob", `/api/projects/${P}/analyses/${CR}/traceability?format=csv`);
        expect(csv.status).toBe(200);
        expect(csv.text).not.toContain("Payroll");
        expect(csv.text).toContain("Customers can pay");
        const gap = await get("bob", `/api/projects/${P}/analyses/${CR}/gap-report`);
        expect(gap.status).toBe(200);
        expect(JSON.stringify(gap.body)).not.toContain("Payroll");
        const aliceCsv = await get(
          "alice",
          `/api/projects/${P}/analyses/${CR}/traceability?format=csv`,
        );
        expect(aliceCsv.text).toContain(SECRET);
      });

      it("a restricted requirement's database changes answer like an unknown one", async () => {
        const path = (id: string) =>
          `/api/projects/${P}/analyses/${CR}/gap-report/requirements/${id}/database-changes`;
        expect((await get("bob", path("req-2447-secret"))).status).toBe(404);
        expect((await get("alice", path("req-2447-secret"))).status).toBe(200);
      });

      it("the requirement diff compares a restricted requirement as its placeholder", async () => {
        const diff = await getRequirementDiff({
          projectId: P,
          headAnalysisId: CR,
          baseAnalysisId: LEGACY,
          reader: userSourceReader("bob"),
        });
        expect(JSON.stringify(diff)).not.toContain(`${SECRET}"`);
        const aliceDiff = await getRequirementDiff({
          projectId: P,
          headAnalysisId: CR,
          baseAnalysisId: LEGACY,
          reader: userSourceReader("alice"),
        });
        expect(JSON.stringify(aliceDiff)).toContain(`${SECRET}"`);
      });
    });

    describe("requirements", () => {
      it("the project list shows Bob the placeholder, and a title search never finds it", async () => {
        const all = await get("bob", `/api/projects/${P}/requirements?analysisId=${CR}`);
        expect(all.status).toBe(200);
        const items = all.body.data.items as Array<{
          id: string;
          title: string;
          restricted?: true;
        }>;
        expect(items.find((r) => r.id === "req-2447-secret")).toMatchObject({
          title: RESTRICTED_SOURCE_TITLE,
          restricted: true,
        });
        expect(items.filter((r) => r.restricted).map((r) => r.id)).toEqual(["req-2447-secret"]);

        const search = await get("bob", `/api/projects/${P}/requirements?q=Payroll`);
        // Only the legacy one, which keeps the shared-audience rule.
        expect(search.body.data.items.map((r: { id: string }) => r.id)).toEqual([
          "req-2447-legacy",
        ]);
        const aliceSearch = await get("alice", `/api/projects/${P}/requirements?q=Payroll`);
        expect(aliceSearch.body.data.items.map((r: { id: string }) => r.id).sort()).toEqual([
          "req-2447-legacy",
          "req-2447-secret",
        ]);
      });

      it("a capped title search fills its page from what Bob can see", async () => {
        // The restricted match is the newest, so it takes the one place a cap
        // of 1 leaves when the cap is applied before the redaction.
        const before = await db.requirement.findUniqueOrThrow({
          where: { id: "req-2447-secret" },
          select: { updatedAt: true },
        });
        await db.requirement.update({
          where: { id: "req-2447-secret" },
          data: { updatedAt: new Date(Date.now() + 60_000) },
        });
        try {
          const bob = await visibleTitleMatches(P, "Payroll", userSourceReader("bob"), 1);
          expect(bob).toEqual({ ids: ["req-2447-legacy"], capped: false });
          const alice = await visibleTitleMatches(P, "Payroll", userSourceReader("alice"), 1);
          expect(alice).toEqual({ ids: ["req-2447-secret"], capped: true });
        } finally {
          await db.requirement.update({
            where: { id: "req-2447-secret" },
            data: { updatedAt: before.updatedAt },
          });
        }
      });

      it("the discussion requirement picker never offers Bob the restricted one", async () => {
        const ids = async (who: Who, q: string) =>
          (
            (await get(who, `/api/discussions/requirements?projectId=${P}&q=${q}`)).body
              .data as Array<{
              id: string;
            }>
          ).map((r) => r.id);
        expect(await ids("bob", "Payroll")).toEqual(["req-2447-legacy"]);
        expect(await ids("bob", "")).not.toContain("req-2447-secret");
        expect((await ids("alice", "Payroll")).sort()).toEqual([
          "req-2447-legacy",
          "req-2447-secret",
        ]);
      });

      it("its traceability chain answers 404 to Bob, as for an unknown id", async () => {
        const chain = (who: Who, id: string) =>
          get(who, `/api/projects/${P}/requirements/${id}/traceability`);
        const bob = await chain("bob", "req-2447-secret");
        const unknown = await chain("bob", "req-2447-nope");
        expect(bob.status).toBe(404);
        expect(bob.body.error).toEqual(unknown.body.error);
        expect(JSON.stringify(bob.body)).not.toContain("Payroll");
        expect((await chain("bob", "req-2447-open")).status).toBe(200);
        expect((await chain("alice", "req-2447-secret")).body.data.requirementTitle).toBe(SECRET);
        const linked = await get(
          "bob",
          `/api/projects/${P}/requirements/req-2447-secret/traceability?includeLinked=true`,
        );
        expect(linked.status).toBe(404);
      });

      it("every /api/requirements/:id route answers 404 to Bob, as for an unknown id", async () => {
        const bob = await get("bob", "/api/requirements/req-2447-secret/history/export");
        const unknown = await get("bob", "/api/requirements/req-2447-nope/history/export");
        expect(bob.status).toBe(404);
        expect(bob.body.error).toEqual(unknown.body.error);
        expect((await get("bob", "/api/requirements/req-2447-open/history/export")).status).toBe(
          200,
        );
        expect(
          (await get("alice", "/api/requirements/req-2447-secret/history/export")).status,
        ).toBe(200);
        expect((await get("root", "/api/requirements/req-2447-secret/history/export")).status).toBe(
          200,
        );
      });

      it("an edit on the change request page is refused to Bob before the lock reads it", async () => {
        const patch = (who: Who) =>
          request(app())
            .patch(`/api/analyses/${CR}/requirements/req-2447-secret`)
            .set("Authorization", bearer(who))
            .send({ priority: "low", version: 0 });
        const bob = await patch("bob");
        expect(bob.status).toBe(404);
        expect(JSON.stringify(bob.body)).not.toContain("Payroll");
        expect((await patch("alice")).status).toBe(200);
      });
    });

    describe("the Spec Kit handoff", () => {
      it("is built only from what the whole project can see", async () => {
        const err = await loadApprovedRequirements(P, ["req-2447-open", "req-2447-secret"]).catch(
          (e) => e,
        );
        expect(err).toBeInstanceOf(SpecKitRequirementSeedError);
        expect(err).toMatchObject({
          status: 422,
          code: "SPECKIT_REQUIREMENTS_RESTRICTED",
          requirementIds: ["req-2447-secret"],
        });
        const ok = await loadApprovedRequirements(P, [
          "req-2447-open",
          "req-2447-run",
          "req-2447-legacy",
        ]);
        expect(ok.map((r) => r.id)).toEqual(["req-2447-open", "req-2447-run", "req-2447-legacy"]);
      });
    });

    describe("chat citations", () => {
      const ctx = (userId: Who) => ({ sessionId: "s", userId, projectId: P });

      it("get_analysis hands the model the placeholder, never the restricted text", async () => {
        const tool = createGetAnalysisTool();
        const bob = await tool.exec({ analysisId: CR }, ctx("bob"));
        expect(bob.isError).toBeFalsy();
        expect(bob.text).toContain("[finding:f-secret]");
        expect(bob.text).toContain("[cross-doc:c-secret]");
        expect(bob.text).not.toContain("Payroll");
        const alice = await tool.exec({ analysisId: CR }, ctx("alice"));
        expect(alice.text).toContain(SECRET);
      });

      it("get_analysis on a shared surface reads as the whole audience, not the asker", async () => {
        const tool = createGetAnalysisTool();
        for (const who of ["alice", "root"] as const) {
          const shared = await tool.exec(
            { analysisId: CR },
            { ...ctx(who), aclAudience: "shared" as const },
          );
          expect(shared.text).toContain("[finding:f-secret]");
          expect(shared.text).not.toContain("Payroll");
        }
      });

      it("the requirement tools list it as the placeholder and refuse to read it", async () => {
        const list = await createListRequirementsTool({
          semantic: async () => [],
        }).exec({}, ctx("bob"));
        expect(list.text).not.toContain("Payroll export for the CFO]");
        expect(list.text).toContain("[req-2447-secret] Restricted");
        const read = await createGetRequirementTool().exec(
          { requirementId: "req-2447-secret" },
          ctx("bob"),
        );
        expect(read.isError).toBe(true);
        expect(read.text).not.toContain("Payroll");
        const aliceRead = await createGetRequirementTool().exec(
          { requirementId: "req-2447-secret" },
          ctx("alice"),
        );
        expect(aliceRead.text).toContain(SECRET);
      });

      it("an 'Ask about this' chat on it is not found for Bob", async () => {
        await expect(
          resolveChatSubject(payload("bob"), "requirement", "req-2447-secret"),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
          resolveChatSubject(payload("alice"), "requirement", "req-2447-secret"),
        ).resolves.toMatchObject({ title: SECRET });
      });
    });

    describe("deep dive and publish", () => {
      it("a restricted finding is not found for Bob, through the route too", async () => {
        const load = (who: Who) =>
          loadFindingForDeepDive({
            projectId: P,
            analysisId: CR,
            findingId: "f-secret",
            reader: userSourceReader(who),
          });
        expect(await load("bob")).toBeNull();
        expect(await load("alice")).toMatchObject({ title: SECRET });
        const res = await request(app())
          .post(`/api/projects/${P}/analyses/${CR}/findings/f-secret/publish`)
          .set("Authorization", bearer("bob"))
          .send({ draft: { title: "t", problemStatement: "p" } });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("FINDING_NOT_FOUND");
      });
    });

    describe("the portfolio and impact checks", () => {
      it("a change request's checks read only the requirements the starter can see", async () => {
        const bob = await loadChangeRequestSource(CR, async () => true, userSourceReader("bob"));
        expect(bob.requirements.map((r) => r.id).sort()).toEqual(["req-2447-open", "req-2447-run"]);
        const alice = await loadChangeRequestSource(
          CR,
          async () => true,
          userSourceReader("alice"),
        );
        expect(alice.requirements.map((r) => r.id).sort()).toEqual([
          "req-2447-open",
          "req-2447-run",
          "req-2447-secret",
        ]);
        const shared = await loadChangeRequestSource(CR, async () => true, sharedSourceReader());
        expect(shared.requirements.map((r) => r.id)).not.toContain("req-2447-secret");
      });

      it("says how many requirements were left out, never which", async () => {
        const bob = await loadChangeRequestSource(CR, async () => true, userSourceReader("bob"));
        expect(bob.restrictedLeftOut).toBe(1);
        expect(restrictedNotChecked(bob)).toEqual([
          { text: "1 requirement", reason: "restricted-source", count: 1 },
        ]);
        const alice = await loadChangeRequestSource(
          CR,
          async () => true,
          userSourceReader("alice"),
        );
        expect(alice.restrictedLeftOut).toBe(0);
        expect(restrictedNotChecked(alice)).toEqual([]);
      });

      it("a portfolio check of a restricted requirement is not found for Bob", async () => {
        await expect(
          loadReadableSourceRequirement(payload("bob"), "req-2447-secret"),
        ).rejects.toMatchObject({
          statusCode: 404,
        });
        await expect(
          loadReadableSourceRequirement(payload("alice"), "req-2447-secret"),
        ).resolves.toMatchObject({ title: SECRET });
      });

      it("an impact analysis started by Bob never sends the restricted requirement", async () => {
        const post = (who: Who, body: object) =>
          request(app()).post("/api/impact-analyses").set("Authorization", bearer(who)).send(body);
        const fromCr = await post("bob", { analysisId: CR, projectIds: [P] });
        expect(fromCr.status).toBe(202);
        // #2447 — the starter is told how many were left out, never which.
        expect(fromCr.body.data.requirementsLeftOut).toBe(1);
        expect(JSON.stringify(fromCr.body)).not.toContain("req-2447-secret");
        const aliceCr = await post("alice", { analysisId: CR, projectIds: [P] });
        expect(aliceCr.body.data).not.toHaveProperty("requirementsLeftOut");
        triggerSpy.mockClear();
        await post("bob", { analysisId: CR, projectIds: [P] });
        expect(triggerSpy.mock.calls[0]![0].requirementIds.sort()).toEqual([
          "req-2447-open",
          "req-2447-run",
        ]);

        const named = await post("bob", { requirementIds: ["req-2447-secret"], projectIds: [P] });
        expect(named.status).toBe(403);
        expect(triggerSpy).toHaveBeenCalledTimes(1);
        expect(
          (await post("alice", { requirementIds: ["req-2447-secret"], projectIds: [P] })).status,
        ).toBe(202);
      });
    });
  },
);
