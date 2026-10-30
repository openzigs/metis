/**
 * #1389 — a Regenerate's re-synthesis erased an approved requirement's
 * acceptance criteria (2 → 0) on analysis `cmviuhc12000icg9kaf5jho38`.
 *
 * The data showed the write: the approval checkpoint promoted 19 rows with
 * their criteria and `reviewStatus = approved`; the Regenerate re-ran synthesis,
 * whose model gave "Minimalist, fast, lightweight feed reader" no criteria, and
 * `persistRequirements` replaced the set — hard-deleting every row and
 * re-creating it from the new output at version 0, so the two criteria were
 * gone with no version row, and every row came back unreviewed.
 *
 * Now an approved requirement always keeps the criteria approved at the
 * checkpoint; a re-synthesis's different (or missing) criteria become a
 * proposal the analyst accepts or dismisses. Proven end to end: a REAL
 * `AnalysisOrchestrator` regenerates an agent over a real migrated SQLite
 * database with a scripted provider, and the analyst answers through the real
 * requirements router (accept, dismiss, Restore).
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
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
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

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { promoteApprovedRequirements } = await import("../src/lib/analysis/promote-requirements.js");
const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");
const { SYNTHESIS_STRUCTURED_IDS_RULE } = await import("../src/lib/analysis/prompts.js");
const { CLARIFICATIONS_START } = await import("../src/lib/analysis/clarification-enrichment.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");
const { ACCEPTED_CRITERIA_PROPOSAL_REASON, APPROVED_CRITERIA_KEY, KEPT_APPROVED_CRITERIA_REASON } =
  await import("../src/lib/analysis/approved-criteria-carry-over.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-1389";
const OTHER_WS = "ws-1389-x";
const OTHER_PROJECT = "p-1389-x";
const PROJECT = "p-1389";
const ANALYST = "u-1389";
const READER = "u-1389-reader";
/** #1588 — starts a run without `project.update`. */
const DEVELOPER = "u-1389-developer";
const RUN_ID = "extraction-run-1389";
const MODEL = "claude-sonnet-4-6";

const structured = (id: string, title: string, description: string) => ({
  id,
  title,
  description,
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});
const MINIMAL = structured(
  "REQ-1",
  "Minimalist, fast, lightweight feed reader",
  "The product must be a minimalist feed reader that is simple, fast and easy to install.",
);
const FEEDS = structured(
  "REQ-2",
  "Feed listing REST API endpoints",
  "The REST API must expose feed listing via GET /v1/feeds.",
);

const item = (title: string, structuredId: string, criteria: string[]) => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [0],
  acceptanceCriteria: criteria,
  structuredIds: [structuredId],
});
const APPROVED_MINIMAL = ["Installs as a single binary.", "A page renders in under 200 ms."];
const APPROVED_FEEDS = ["GET /v1/feeds lists the user's feeds."];
const REVISED_FEEDS = ["GET /v1/feeds returns 200 with a JSON array of feeds."];
const REVISED_AGAIN = ["GET /v1/feeds pages its results 100 at a time."];

/** The first run's synthesis, the one the approval checkpoint promoted. */
const firstSynthesis = {
  summary: "Two requirements.",
  requirements: [
    item("Minimalist feed reader", "REQ-1", APPROVED_MINIMAL),
    item("Feed listing endpoints", "REQ-2", APPROVED_FEEDS),
  ],
};
/**
 * A regenerate's synthesis: `feeds` for REQ-2 and, by default, no criteria for
 * REQ-1 (the #1389 incident shape).
 */
const reSynthesis = (feeds: string[], minimal: string[] = []) =>
  JSON.stringify({
    summary: "Two requirements, re-synthesised.",
    requirements: [
      item("Make the minimalist product goals measurable", "REQ-1", minimal),
      item("Serve feed listings", "REQ-2", feeds),
    ],
  });
/** APPROVED_FEEDS reworded the way re-syntheses do: case, punctuation, a cited line. */
const REWORDED_FEEDS = ["get /v1/feeds lists the user's feeds (internal/api/api.go:43)"];
const agentJson = JSON.stringify({
  summary: "summary",
  findings: [
    {
      category: "functional",
      severity: "medium",
      title: "A finding",
      body: "Body",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/** Synthesis calls get `synthesis`; every other call the agent payload. */
function scriptedProvider(synthesis: string): AIProvider & { synthesisCalls: number } {
  const p = {
    key: "anthropic" as const,
    model: MODEL,
    offline: false,
    synthesisCalls: 0,
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      const isSynthesis = JSON.stringify([opts?.systemMessage, messages]).includes(
        SYNTHESIS_STRUCTURED_IDS_RULE.slice(0, 60),
      );
      if (isSynthesis) p.synthesisCalls += 1;
      return {
        content: isSynthesis ? synthesis : agentJson,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        model: MODEL,
        provider: "anthropic",
      };
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return [MODEL];
    },
    async ping() {
      return true;
    },
  };
  return p as unknown as AIProvider & { synthesisCalls: number };
}

const stubKnowledge = { search: async () => ({ hits: [] }) } as unknown as KnowledgeService;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1389 — a regenerate's re-synthesis keeps what was approved (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ANALYST_TOKEN = "";
    let READER_TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const answer = (id: string, body: Record<string, unknown>, token = ANALYST_TOKEN) =>
      request(app())
        .post(`/api/requirements/${id}/criteria-proposal`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    const keepAll = (analysisId: string, project = PROJECT, token = ANALYST_TOKEN) =>
      request(app())
        .post(`/api/projects/${project}/analyses/${analysisId}/criteria-proposals/dismiss-all`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
    const restore = (id: string, version: number) =>
      request(app())
        .post(`/api/requirements/${id}/restore/${version}`)
        .set("Authorization", `Bearer ${ANALYST_TOKEN}`)
        .send({});

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1389-resynthesis-approved-criteria");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      // #1588 — a regenerate re-creates the set `approved` only when the run's
      // starter holds `project.update`, read from durable roles: the analyst
      // is a coordinator there, as their token says.
      const roleIds = new Map<string, string>();
      for (const key of ["coordinator", "developer", "reader"]) {
        const role = await db.role.upsert({
          where: { key },
          update: {},
          create: { key, name: key, isSystem: true },
        });
        roleIds.set(key, role.id);
      }
      for (const [id, role] of [
        [ANALYST, "coordinator"],
        [READER, "reader"],
        [DEVELOPER, "developer"],
      ] as const) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({
          data: { userId: id, roleId: roleIds.get(role)!, source: "local" },
        });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: id, role: "member" } });
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: ANALYST, workspaceId: WS },
      });
      // A project the analyst cannot reach.
      await db.workspace.create({ data: { id: OTHER_WS, name: "x", slug: OTHER_WS } });
      await db.project.create({
        data: {
          id: OTHER_PROJECT,
          name: OTHER_PROJECT,
          slug: OTHER_PROJECT,
          createdById: ANALYST,
          workspaceId: OTHER_WS,
        },
      });
      const token = (userId: string, role: "coordinator" | "reader") =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces: [WS] })
          .accessToken;
      ANALYST_TOKEN = token(ANALYST, "coordinator");
      READER_TOKEN = token(READER, "reader");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function seedPromotedAnalysis(
      analysisId: string,
      first: typeof firstSynthesis = firstSynthesis,
      startedById: string | null = ANALYST,
      promotedBy: { asApproved: boolean } = { asApproved: true },
    ): Promise<void> {
      await db.analysis.create({
        data: {
          id: analysisId,
          projectId: PROJECT,
          startedById,
          status: "completed",
          metadata: JSON.stringify({
            agentKeys: ["web"],
            structuredRequirements: {
              requirements: [MINIMAL, FEEDS],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: RUN_ID,
          }),
        },
      });
      await db.agentResult.create({
        data: {
          analysisId,
          agentKey: "synthesis",
          status: "completed",
          output: JSON.stringify(first),
        },
      });
      await db.approvalRequest.createMany({
        data: ["REQ-1", "REQ-2"].map((itemId) => ({
          analysisId,
          type: "requirement",
          itemId,
          status: "approved",
          reviewedAt: new Date(),
        })),
      });
      expect(await promoteApprovedRequirements(analysisId, promotedBy)).toEqual({
        status: "promoted",
        requirementCount: 2,
      });
    }

    const rowFor = async (analysisId: string, structuredId: string) => {
      const row = await db.requirement.findFirst({
        where: { analysisId, promotedStructuredId: structuredId },
        include: { versions: { orderBy: { version: "asc" } } },
      });
      expect(row, structuredId).not.toBeNull();
      return row!;
    };
    const criteriaOf = async (analysisId: string, structuredId: string) =>
      JSON.parse((await rowFor(analysisId, structuredId)).acceptanceCriteria) as string[];
    const proposalOf = async (analysisId: string, structuredId: string) => {
      const row = await rowFor(analysisId, structuredId);
      const snap = await getAnalysisSnapshot(analysisId);
      return snap!.requirements.find((r) => r.id === row.id)!.criteriaProposal ?? null;
    };

    async function regenerate(
      analysisId: string,
      feeds: string[],
      minimal: string[] = [],
      actorId: string = ANALYST,
    ) {
      const before = await rowFor(analysisId, "REQ-1");
      const provider = scriptedProvider(reSynthesis(feeds, minimal));
      const orch = new AnalysisOrchestrator({
        provider,
        knowledge: stubKnowledge,
        webSearchConfigured: () => true,
      });
      await orch.regenerateAgent({ analysisId, agentKey: "web", actorId });
      expect((await db.analysis.findUnique({ where: { id: analysisId } }))?.status).toBe(
        "completed",
      );
      expect(provider.synthesisCalls).toBeGreaterThan(0);
      return before;
    }

    it("keeps the approved criteria the re-synthesis omitted, silently, and proposes a material change", async () => {
      const id = "ana-1389-kept";
      await seedPromotedAnalysis(id);
      const promoted = await regenerate(id, REVISED_FEEDS);

      // The set really was replaced…
      const minimal = await rowFor(id, "REQ-1");
      expect(minimal.id).not.toBe(promoted.id);
      // …but REQ-1 keeps the two approved criteria (the #1389 symptom was `[]`),
      // and a re-synthesis that gave none raises nothing: no notice, no version.
      expect(JSON.parse(minimal.acceptanceCriteria)).toEqual(APPROVED_MINIMAL);
      expect(minimal.reviewStatus).toBe("approved");
      expect(minimal.versions).toHaveLength(0);
      expect(await proposalOf(id, "REQ-1")).toBeNull();

      // REQ-2 keeps its approved criteria too; the revision is only a proposal,
      // and the approved criteria are a system version of their own.
      const feeds = await rowFor(id, "REQ-2");
      expect(JSON.parse(feeds.acceptanceCriteria)).toEqual(APPROVED_FEEDS);
      expect(feeds.reviewStatus).toBe("approved");
      expect(feeds.versions).toHaveLength(1);
      expect(feeds.versions[0]).toMatchObject({
        version: 1,
        actorId: null,
        reason: KEPT_APPROVED_CRITERIA_REASON,
      });
      expect(await proposalOf(id, "REQ-2")).toMatchObject({ proposed: REVISED_FEEDS });
    });

    it("criteria that differ only in wording, case or cited lines raise nothing", async () => {
      const id = "ana-1389-reworded";
      await seedPromotedAnalysis(id);
      await regenerate(id, REWORDED_FEEDS);
      const feeds = await rowFor(id, "REQ-2");
      expect(JSON.parse(feeds.acceptanceCriteria)).toEqual(APPROVED_FEEDS);
      expect(feeds.versions).toHaveLength(0);
      expect(await proposalOf(id, "REQ-2")).toBeNull();
    });

    it("Accept writes the proposal as the analyst's version; Restore brings the approved criteria back", async () => {
      const id = "ana-1389-accept";
      await seedPromotedAnalysis(id);
      await regenerate(id, REVISED_FEEDS);
      const row = await rowFor(id, "REQ-2");
      expect(row.version).toBe(1);

      const res = await answer(row.id, { choice: "accept", version: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ choice: "accept", version: 2, changed: true });

      const accepted = await rowFor(id, "REQ-2");
      expect(JSON.parse(accepted.acceptanceCriteria)).toEqual(REVISED_FEEDS);
      expect(accepted.versions.at(-1)).toMatchObject({
        version: 2,
        actorId: ANALYST,
        reason: ACCEPTED_CRITERIA_PROPOSAL_REASON,
      });
      expect(await proposalOf(id, "REQ-2")).toBeNull();

      // Restore, through the real route, to the version holding the approved criteria.
      const restored = await restore(row.id, 1);
      expect(restored.status).toBe(200);
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);
    });

    it("a stale version, a missing proposal and a reader are refused", async () => {
      const id = "ana-1389-refused";
      await seedPromotedAnalysis(id);
      await regenerate(id, REVISED_FEEDS);
      const row = await rowFor(id, "REQ-2");

      expect((await answer(row.id, { choice: "accept", version: 0 })).status).toBe(409);
      expect((await answer(row.id, { choice: "maybe" })).status).toBe(400);
      // Accepting writes a version, so it must name the one it was based on.
      const unversioned = await answer(row.id, { choice: "accept" });
      expect(unversioned.status).toBe(400);
      expect(unversioned.body.error.code).toBe("VALIDATION_ERROR");
      expect((await answer(row.id, { choice: "accept" }, READER_TOKEN)).status).toBe(403);
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);

      expect((await answer(row.id, { choice: "dismiss" })).status).toBe(200);
      const again = await answer(row.id, { choice: "dismiss" });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("NO_PROPOSAL");
    });

    it("two consecutive regenerates keep the originally approved criteria", async () => {
      const id = "ana-1389-twice";
      await seedPromotedAnalysis(id);
      await regenerate(id, REVISED_FEEDS);
      await regenerate(id, REVISED_AGAIN);

      expect(await criteriaOf(id, "REQ-1")).toEqual(APPROVED_MINIMAL);
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);
      expect(await proposalOf(id, "REQ-2")).toMatchObject({ proposed: REVISED_AGAIN });
      const meta = JSON.parse(
        (await db.analysis.findUniqueOrThrow({ where: { id } })).metadata ?? "{}",
      ) as Record<string, { approved: Record<string, string[]> }>;
      expect(meta[APPROVED_CRITERIA_KEY]!.approved).toEqual({
        "REQ-1": APPROVED_MINIMAL,
        "REQ-2": APPROVED_FEEDS,
      });
      for (const s of ["REQ-1", "REQ-2"]) {
        expect((await rowFor(id, s)).reviewStatus).toBe("approved");
      }
    });

    // #1588 — the regenerate re-creates the set with the permission of whoever
    // triggered it: a developer's Regenerate comes back as drafts, keeping the
    // checkpoint's criteria (#1389) all the same.
    it("a developer's Regenerate of a developer's run re-creates the rows as drafts", async () => {
      const id = "ana-1389-starter-developer";
      await seedPromotedAnalysis(id, firstSynthesis, DEVELOPER);
      await regenerate(id, REVISED_FEEDS, [], DEVELOPER);
      for (const s of ["REQ-1", "REQ-2"]) {
        expect((await rowFor(id, s)).reviewStatus).toBe("draft");
      }
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);
    });

    // #1589 review — the regenerate's trigger decides, not only the run's
    // starter, and the sign-off recorded at promotion is carried over.
    const statuses = async (id: string) => [
      (await rowFor(id, "REQ-1")).reviewStatus,
      (await rowFor(id, "REQ-2")).reviewStatus,
    ];
    it("a developer's Regenerate of a coordinator's run (checkpoint approved as draft) stays draft", async () => {
      const id = "ana-1389-dev-regenerates";
      await seedPromotedAnalysis(id, firstSynthesis, ANALYST, { asApproved: false });
      await regenerate(id, REVISED_FEEDS, [], DEVELOPER);
      expect(await statuses(id)).toEqual(["draft", "draft"]);
    });

    it("a developer's Regenerate of an approved set re-saves it as draft", async () => {
      const id = "ana-1389-dev-regenerates-approved";
      await seedPromotedAnalysis(id);
      await regenerate(id, REVISED_FEEDS, [], DEVELOPER);
      expect(await statuses(id)).toEqual(["draft", "draft"]);
    });

    it("a coordinator's Regenerate does not approve a set promoted as draft", async () => {
      const id = "ana-1389-coord-regenerates-draft";
      await seedPromotedAnalysis(id, firstSynthesis, ANALYST, { asApproved: false });
      await regenerate(id, REVISED_FEEDS);
      expect(await statuses(id)).toEqual(["draft", "draft"]);
    });

    it("a row a coordinator approved after a draft promotion is review work: a Regenerate keeps it", async () => {
      const id = "ana-1389-coord-approves-draft";
      await seedPromotedAnalysis(id, firstSynthesis, ANALYST, { asApproved: false });
      const before = await rowFor(id, "REQ-1");
      await db.requirement.update({ where: { id: before.id }, data: { reviewStatus: "approved" } });
      await regenerate(id, REVISED_FEEDS);
      const after = await rowFor(id, "REQ-1");
      expect(after.id).toBe(before.id);
      expect(after.reviewStatus).toBe("approved");
    });

    it("Dismiss keeps the approved criteria, and holds for that requirement for the run", async () => {
      const id = "ana-1389-dismiss";
      await seedPromotedAnalysis(id);
      await regenerate(id, REVISED_FEEDS);
      const row = await rowFor(id, "REQ-2");

      const res = await answer(row.id, { choice: "dismiss" });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ choice: "dismiss", version: 1, changed: false });
      expect(await proposalOf(id, "REQ-2")).toBeNull();

      // A dismissal is not review work: the set is still replaced next time…
      await regenerate(id, REVISED_FEEDS);
      expect((await rowFor(id, "REQ-2")).id).not.toBe(row.id);
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);
      expect(await proposalOf(id, "REQ-2")).toBeNull();
      // …and a different suggestion for the same requirement is not raised either.
      await regenerate(id, REVISED_AGAIN);
      expect(await proposalOf(id, "REQ-2")).toBeNull();
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);
    });

    it("Keep approved criteria for all dismisses every suggestion in one request", async () => {
      const id = "ana-1389-keep-all";
      await seedPromotedAnalysis(id);
      await regenerate(id, REVISED_FEEDS, ["Starts in one second."]);
      expect(await proposalOf(id, "REQ-1")).toMatchObject({ proposed: ["Starts in one second."] });
      expect(await proposalOf(id, "REQ-2")).toMatchObject({ proposed: REVISED_FEEDS });

      // Another project's analysis is not reachable, and a reader may not answer.
      expect((await keepAll(id, OTHER_PROJECT)).status).toBe(404);
      expect((await keepAll(id, PROJECT, READER_TOKEN)).status).toBe(403);

      const res = await keepAll(id);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ dismissedCount: 2 });
      expect(await proposalOf(id, "REQ-1")).toBeNull();
      expect(await proposalOf(id, "REQ-2")).toBeNull();
      expect(await criteriaOf(id, "REQ-1")).toEqual(APPROVED_MINIMAL);
      expect(await criteriaOf(id, "REQ-2")).toEqual(APPROVED_FEEDS);
      // Nothing left: a second request dismisses none.
      expect((await keepAll(id)).body.data).toEqual({ dismissedCount: 0 });
      // Both hold through the next regenerate.
      await regenerate(id, REVISED_AGAIN, ["Starts in two seconds."]);
      expect(await proposalOf(id, "REQ-1")).toBeNull();
      expect(await proposalOf(id, "REQ-2")).toBeNull();
    });

    it("an older set whose row had no criteria: the proposal is raised, and Accept writes the first version", async () => {
      const id = "ana-1389-older";
      await seedPromotedAnalysis(id, {
        ...firstSynthesis,
        requirements: [
          item("Minimalist feed reader", "REQ-1", []),
          item("Feed listing endpoints", "REQ-2", APPROVED_FEEDS),
        ],
      });
      // A set promoted before the record existed: only the rows say what was approved.
      const analysis = await db.analysis.findUniqueOrThrow({ where: { id } });
      const meta = JSON.parse(analysis.metadata ?? "{}") as Record<string, unknown>;
      delete meta[APPROVED_CRITERIA_KEY];
      await db.analysis.update({ where: { id }, data: { metadata: JSON.stringify(meta) } });

      await regenerate(id, APPROVED_FEEDS, ["Starts in one second."]);
      const row = await rowFor(id, "REQ-1");
      expect(JSON.parse(row.acceptanceCriteria)).toEqual([]);
      // Nothing approved to anchor, so no system version.
      expect(row.versions).toHaveLength(0);
      expect(await proposalOf(id, "REQ-1")).toMatchObject({ proposed: ["Starts in one second."] });

      const res = await answer(row.id, { choice: "accept", version: 0 });
      expect(res.status).toBe(200);
      const accepted = await rowFor(id, "REQ-1");
      expect(JSON.parse(accepted.acceptanceCriteria)).toEqual(["Starts in one second."]);
      expect(accepted.versions).toEqual([
        expect.objectContaining({ version: 1, actorId: ANALYST }),
      ]);
    });

    it("a requirement in a project the analyst cannot reach is 404 on this route", async () => {
      await db.analysis.create({
        data: {
          id: "ana-1389-x",
          projectId: OTHER_PROJECT,
          startedById: ANALYST,
          status: "completed",
        },
      });
      const foreign = await db.requirement.create({
        data: {
          analysisId: "ana-1389-x",
          projectId: OTHER_PROJECT,
          title: "Foreign",
          body: "b",
          acceptanceCriteria: JSON.stringify(["x"]),
        },
      });
      expect((await answer(foreign.id, { choice: "dismiss" })).status).toBe(404);
      expect((await answer(foreign.id, { choice: "accept", version: 0 })).status).toBe(404);
    });

    it("writes the clarification answers back into the re-created row's body", async () => {
      const id = "ana-1389-clarified";
      await seedPromotedAnalysis(id);
      await addClarification(id);
      await regenerate(id, REVISED_FEEDS);
      const row = await rowFor(id, "REQ-1");
      expect(row.body).toContain(CLARIFICATIONS_START);
      expect(row.body).toContain("How fast is fast?");
    });

    it("a withheld replacement keeps the rows and does not re-apply clarifications", async () => {
      const id = "ana-1389-withheld";
      await seedPromotedAnalysis(id);
      await addClarification(id);
      const minimal = await rowFor(id, "REQ-1");
      // A person's edit is review work (#769): the next replacement is withheld.
      await updateRequirementWithHistory(db as never, {
        requirementId: minimal.id,
        patch: { title: "Lightweight feed reader" },
        actorId: ANALYST,
      });

      await regenerate(id, REVISED_FEEDS);

      const after = await rowFor(id, "REQ-1");
      expect(after.id).toBe(minimal.id);
      expect(after.body).not.toContain(CLARIFICATIONS_START);
      const meta = JSON.parse(
        (await db.analysis.findUniqueOrThrow({ where: { id } })).metadata ?? "{}",
      ) as Record<string, unknown>;
      expect(meta.requirementReplacementWithheld).toMatchObject({ reason: "reviewed-work" });
    });

    async function addClarification(analysisId: string) {
      await db.clarificationDialogState.create({
        data: {
          analysisId,
          state: JSON.stringify({
            analysisId,
            currentRound: 1,
            maxRounds: 3,
            rounds: [
              {
                round: 1,
                questions: [
                  {
                    id: "q1",
                    requirementId: "REQ-1",
                    ambiguityField: "speed",
                    question: "How fast is fast?",
                    context: "",
                    answer: "A page renders in under 200 ms.",
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
    }
  },
);
