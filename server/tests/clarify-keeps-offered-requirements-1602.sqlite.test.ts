/**
 * #1602 — a clarify submit read the reviewed (structured) list before its
 * resolution model call and wrote that copy back afterwards, so requirements
 * synthesis offered for review in the meantime (#1569) were erased and their
 * pending approvals orphaned.
 *
 * Both submit paths (`POST /clarify` with answers, and `POST /clarify/import`)
 * run through the real router on a real SQLite database built by the migration
 * chain. The model is a stub whose resolution call is where the interleaving
 * happens: while it "thinks", synthesis appends its offer through the real
 * `offerUnmatchedItemsForReview`. Read back through the analysis metadata and
 * the approval rows, both the clarify rewrite and the offered requirement must
 * be there.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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
  return {
    db: null as unknown,
    /** Run inside the resolution call, between the clarify read and its write. */
    duringResolution: null as null | (() => Promise<unknown>),
  };
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
vi.mock("../src/lib/finops/token-tracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/finops/token-tracker.js")>()),
  recordUsage: vi.fn(),
}));
vi.mock("../src/lib/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/index.js")>();
  const chat = vi.fn(async () => {
    const interleave = state.duringResolution;
    state.duringResolution = null;
    if (interleave) await interleave();
    return {
      content: JSON.stringify({
        resolvedFields: ["scope"],
        updatedDescription: "Export the monthly invoice report for EU invoices only.",
      }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: "offline-stub",
      provider: "offline-stub",
      offline: true,
    };
  });
  return {
    ...actual,
    buildProvider: vi.fn(() => ({ offline: true, chat })),
    loadAIConfig: vi.fn(() => ({ provider: "offline-stub", model: "offline-stub" })),
  };
});
vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: vi.fn(() => ({ search: vi.fn(async () => []) })),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { offerUnmatchedItemsForReview } =
  await import("../src/lib/analysis/offer-synthesis-items.js");
const { mergeClarifiedList } = await import("../src/lib/analysis/analysis-service.js");

const WORKSPACE = "ws-1602";
const PROJECT = "proj-1602";
const ADMIN = "u-1602-admin";
const RUN_ID = "extraction-run-1602";

const R1 = {
  id: "REQ-1",
  title: "Export the monthly invoice report",
  description: "Export the monthly invoice report.",
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [
    { field: "scope", description: "Which invoices?", suggestedQuestion: "Which invoices?" },
  ],
  evidenceNeeds: [],
  rawSource: "",
};
/** A synthesis item that restates nothing reviewed, so synthesis offers it (#1569). */
const OFFERED = {
  type: "feature",
  title: "Publish an OpenAPI description of the v1 API",
  body: "Publish an OpenAPI description of the v1 API.",
  priority: "high",
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: ["An OpenAPI 3 document is served"],
  structuredIds: [],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1602 — a clarify submit keeps the requirements synthesis offered meanwhile",
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
    const token = () =>
      issueTokens({
        userId: ADMIN,
        username: ADMIN,
        role: "admin",
        permissions: [],
        workspaces: [WORKSPACE],
      }).accessToken;
    const base = (analysisId: string) => `/api/projects/${PROJECT}/analyses/${analysisId}`;

    /** A run at its checkpoint: REQ-1 under review, one open question on it. */
    async function seedAnalysis(): Promise<string> {
      seq += 1;
      const id = `ana-1602-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: ADMIN,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [R1],
              totalAmbiguities: 1,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: RUN_ID,
          }),
        },
      });
      await db.approvalRequest.create({
        data: { analysisId: id, type: "requirement", itemId: "REQ-1", status: "pending" },
      });
      await db.clarificationDialogState.create({
        data: {
          analysisId: id,
          state: JSON.stringify({
            analysisId: id,
            currentRound: 1,
            maxRounds: 3,
            rounds: [
              {
                round: 1,
                questions: [
                  {
                    id: "q-1",
                    requirementId: "REQ-1",
                    ambiguityField: "scope",
                    question: "Which invoices does the export cover?",
                    context: "",
                    groundingStatus: "open",
                  },
                ],
                answers: [],
              },
            ],
            resolvedAmbiguities: [],
            escalatedToSonnet: false,
            completed: false,
          }),
        },
      });
      // Synthesis offers its unmatched item while the clarify call is out.
      state.duringResolution = () => offerUnmatchedItemsForReview(id, [OFFERED] as never);
      return id;
    }

    const reviewedList = async (analysisId: string) => {
      const row = await db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
      return JSON.parse(row.metadata ?? "{}").structuredRequirements as {
        requirements: Array<{ id: string; title: string; description: string }>;
        totalAmbiguities: number;
      };
    };

    /** Both writes survived: the clarify rewrite of REQ-1 and the offered requirement. */
    async function expectBothSurvive(analysisId: string) {
      expect(state.duringResolution, "the interleaving append never ran").toBeNull();
      const list = await reviewedList(analysisId);
      const offered = list.requirements.filter((r) => r.id.startsWith("SYN-"));
      expect(list.requirements.map((r) => r.id)).toEqual(["REQ-1", offered[0]?.id]);
      expect(list.requirements[0].description).toBe(
        "Export the monthly invoice report for EU invoices only.",
      );
      expect(offered).toEqual([expect.objectContaining({ title: OFFERED.title })]);
      // Its pending approval names a requirement the reviewed list still has.
      const approvals = await db.approvalRequest.findMany({
        where: { analysisId, type: "requirement" },
        orderBy: { createdAt: "asc" },
        select: { itemId: true, status: true },
      });
      expect(approvals).toEqual([
        { itemId: "REQ-1", status: "pending" },
        { itemId: offered[0].id, status: "pending" },
      ]);
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1602-clarify-keeps-offered");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      await db.user.create({
        data: { id: ADMIN, username: ADMIN, displayName: ADMIN, email: `${ADMIN}@example.test` },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WORKSPACE, userId: ADMIN, role: "member" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: ADMIN,
          workspaceId: WORKSPACE,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.duringResolution = null;
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("POST /clarify with answers", async () => {
      const id = await seedAnalysis();
      const res = await request(app())
        .post(`${base(id)}/clarify`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ answers: [{ questionId: "q-1", answer: "Only EU invoices" }] });
      expect(res.status).toBe(200);
      await expectBothSurvive(id);
    });

    it("POST /clarify/import (the CSV round-trip)", async () => {
      const id = await seedAnalysis();
      const csv =
        "questionId,requirement,ambiguityField,question,suggestedAnswer,answer\r\n" +
        "q-1,Export the monthly invoice report,scope,Which invoices?,,Only EU invoices\r\n";
      const res = await request(app())
        .post(`${base(id)}/clarify/import`)
        .set("Authorization", `Bearer ${token()}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ applied: 1 });
      await expectBothSurvive(id);
    });

    it("writes nothing over a list a new extraction run replaced meanwhile", async () => {
      const id = await seedAnalysis();
      const fresh = { ...R1, description: "Run 2's REQ-1: a different requirement." };
      state.duringResolution = () =>
        db.analysis.update({
          where: { id },
          data: {
            metadata: JSON.stringify({
              structuredRequirements: {
                requirements: [fresh],
                totalAmbiguities: 1,
                totalEvidenceNeeds: 0,
              },
              structuredRunId: "extraction-run-1602-b",
            }),
          },
        });
      const res = await request(app())
        .post(`${base(id)}/clarify`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ answers: [{ questionId: "q-1", answer: "Only EU invoices" }] });
      expect(res.status).toBe(200);
      expect((await reviewedList(id)).requirements).toEqual([fresh]);
    });
  },
);

describe("mergeClarifiedList (#1602)", () => {
  const req = (id: string, description: string, ambiguities = 0) => ({
    ...R1,
    id,
    description,
    ambiguities: Array.from({ length: ambiguities }, (_, i) => ({
      field: `f${i}`,
      description: "",
      suggestedQuestion: "",
    })),
  });
  const list = (requirements: ReturnType<typeof req>[], totalAmbiguities = 0) => ({
    requirements: requirements as never[],
    totalAmbiguities,
    totalEvidenceNeeds: 0,
  });

  it("applies only the fields the round changed, onto the current requirement", () => {
    const before = list([req("REQ-1", "old"), req("REQ-2", "two")]);
    const after = list([req("REQ-1", "rewritten"), req("REQ-2", "two")]);
    // Meanwhile another writer changed REQ-2's description and title.
    const current = list([{ ...req("REQ-1", "old"), title: "Retitled" }, req("REQ-2", "edited")]);
    const merged = mergeClarifiedList(current, undefined, before, after)!;
    expect(merged.requirements).toEqual([
      { ...req("REQ-1", "rewritten"), title: "Retitled" },
      req("REQ-2", "edited"),
    ]);
  });

  it("keeps a requirement the list gained, counting its ambiguities, and does not restore one it lost", () => {
    const before = list([req("REQ-1", "a", 2), req("REQ-2", "b", 1)], 3);
    const after = list([req("REQ-1", "a2", 2), req("REQ-2", "b", 1)], 1);
    const current = list([req("REQ-1", "a", 2), req("SYN-x", "offered", 2)]);
    const merged = mergeClarifiedList(current, "run-1", { ...before, runId: "run-1" }, after)!;
    expect(merged.requirements.map((r) => [r.id, r.description])).toEqual([
      ["REQ-1", "a2"],
      ["SYN-x", "offered"],
    ]);
    expect(merged.totalAmbiguities).toBe(1 + 2);
  });

  it("is the round's own list when nothing is stored, without the read-side run id", () => {
    const after = { ...list([req("REQ-1", "a")], 0), runId: "run-1" };
    expect(mergeClarifiedList(undefined, undefined, after, after)).toEqual(
      list([req("REQ-1", "a")]),
    );
  });

  it("returns null when the stored list is another run's", () => {
    const before = { ...list([req("REQ-1", "a")]), runId: "run-1" };
    expect(mergeClarifiedList(list([req("REQ-1", "b")]), "run-2", before, before)).toBeNull();
    // A list the client sent (no run id) is merged by id.
    expect(
      mergeClarifiedList(
        list([req("REQ-1", "b")]),
        "run-2",
        list([req("REQ-1", "b")]),
        list([req("REQ-1", "c")]),
      ),
    ).toMatchObject({ requirements: [expect.objectContaining({ description: "c" })] });
  });
});
