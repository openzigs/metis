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
 * Reproduced here end to end: a REAL `AnalysisOrchestrator` regenerates an
 * agent over a real migrated SQLite database, with a scripted provider whose
 * re-synthesis omits one requirement's criteria and rewrites another's.
 */
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

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { promoteApprovedRequirements } = await import("../src/lib/analysis/promote-requirements.js");
const { SYNTHESIS_STRUCTURED_IDS_RULE } = await import("../src/lib/analysis/prompts.js");
const { CLARIFICATIONS_START } = await import("../src/lib/analysis/clarification-enrichment.js");
const { KEPT_APPROVED_CRITERIA_REASON, REVISED_APPROVED_CRITERIA_REASON } =
  await import("../src/lib/analysis/approved-criteria-carry-over.js");

const PROJECT = "p-1389";
const USER = "u-1389";
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

/** The first run's synthesis, the one the approval checkpoint promoted. */
const firstSynthesis = {
  summary: "Two requirements.",
  requirements: [
    item("Minimalist feed reader", "REQ-1", APPROVED_MINIMAL),
    item("Feed listing endpoints", "REQ-2", APPROVED_FEEDS),
  ],
};
/** The regenerate's synthesis: no criteria for REQ-1 (as in the run), new ones for REQ-2. */
const reSynthesis = JSON.stringify({
  summary: "Two requirements, re-synthesised.",
  requirements: [
    item("Make the minimalist product goals measurable", "REQ-1", []),
    item("Serve feed listings", "REQ-2", REVISED_FEEDS),
  ],
});
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

/** Synthesis calls get {@link reSynthesis}; every other call the agent payload. */
function scriptedProvider(): AIProvider & { synthesisCalls: number } {
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
        content: isSynthesis ? reSynthesis : agentJson,
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

async function seedPromotedAnalysis(db: PrismaClient, analysisId: string): Promise<void> {
  await db.analysis.create({
    data: {
      id: analysisId,
      projectId: PROJECT,
      startedById: USER,
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
      output: JSON.stringify(firstSynthesis),
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
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1389 — a regenerate's re-synthesis keeps what was approved (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1389-resynthesis-approved-criteria");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const rowFor = async (analysisId: string, structuredId: string) => {
      const row = await db.requirement.findFirst({
        where: { analysisId, promotedStructuredId: structuredId },
        include: { versions: { orderBy: { version: "asc" } } },
      });
      expect(row, structuredId).not.toBeNull();
      return row!;
    };

    async function promoteThenRegenerate(analysisId: string) {
      expect(await promoteApprovedRequirements(analysisId)).toEqual({
        status: "promoted",
        requirementCount: 2,
      });
      const promoted = await rowFor(analysisId, "REQ-1");
      expect(JSON.parse(promoted.acceptanceCriteria)).toEqual(APPROVED_MINIMAL);
      expect(promoted.reviewStatus).toBe("approved");

      const provider = scriptedProvider();
      const orch = new AnalysisOrchestrator({
        provider,
        knowledge: stubKnowledge,
        webSearchConfigured: () => true,
      });
      await orch.regenerateAgent({ analysisId, agentKey: "web", actorId: USER });
      expect((await db.analysis.findUnique({ where: { id: analysisId } }))?.status).toBe(
        "completed",
      );
      // The re-synthesis really ran, and really replaced the set.
      expect(provider.synthesisCalls).toBeGreaterThan(0);
      expect((await rowFor(analysisId, "REQ-1")).id).not.toBe(promoted.id);
    }

    it("keeps the approved criteria the re-synthesis omitted, and says so in the history", async () => {
      await promoteThenRegenerate("ana-1389-kept");
      const row = await rowFor("ana-1389-kept", "REQ-1");

      expect(JSON.parse(row.acceptanceCriteria)).toEqual(APPROVED_MINIMAL);
      expect(row.version).toBe(1);
      expect(row.versions).toHaveLength(1);
      expect(row.versions[0]).toMatchObject({
        version: 1,
        actorId: null,
        reason: KEPT_APPROVED_CRITERIA_REASON,
      });
      expect(JSON.parse(row.versions[0]!.changedFields)).toEqual({
        acceptanceCriteria: { from: "[]", to: JSON.stringify(APPROVED_MINIMAL) },
      });
    });

    it("takes revised criteria, but through the history, so the approved ones can be restored", async () => {
      await promoteThenRegenerate("ana-1389-revised");
      const row = await rowFor("ana-1389-revised", "REQ-2");

      expect(JSON.parse(row.acceptanceCriteria)).toEqual(REVISED_FEEDS);
      expect(row.versions).toHaveLength(1);
      expect(row.versions[0]).toMatchObject({
        version: 1,
        actorId: null,
        reason: REVISED_APPROVED_CRITERIA_REASON,
      });
      expect(JSON.parse(row.versions[0]!.changedFields)).toEqual({
        acceptanceCriteria: {
          from: JSON.stringify(APPROVED_FEEDS),
          to: JSON.stringify(REVISED_FEEDS),
        },
      });
    });

    it("keeps every re-created row approved, and a later regenerate can still replace the set", async () => {
      const id = "ana-1389-status";
      await promoteThenRegenerate(id);
      const rows = await db.requirement.findMany({ where: { analysisId: id } });
      expect(rows.map((r) => r.reviewStatus)).toEqual(["approved", "approved"]);

      // The system's version rows and the checkpoint's approval are not review
      // work (#769): a second regenerate replaces the set again, and the
      // approved criteria survive that one too.
      const orch = new AnalysisOrchestrator({
        provider: scriptedProvider(),
        knowledge: stubKnowledge,
        webSearchConfigured: () => true,
      });
      await orch.regenerateAgent({ analysisId: id, agentKey: "web", actorId: USER });
      const again = await rowFor(id, "REQ-1");
      expect(again.id).not.toBe(rows.find((r) => r.promotedStructuredId === "REQ-1")!.id);
      expect(JSON.parse(again.acceptanceCriteria)).toEqual(APPROVED_MINIMAL);
      expect(again.reviewStatus).toBe("approved");
    });

    it("writes the clarification answers back into the re-created row's body", async () => {
      const id = "ana-1389-clarified";
      await seedPromotedAnalysis(db, id);
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
      await promoteThenRegenerate(id);
      const row = await rowFor(id, "REQ-1");
      expect(row.body).toContain(CLARIFICATIONS_START);
      expect(row.body).toContain("How fast is fast?");
    });

    beforeAll(async () => {
      for (const id of ["ana-1389-kept", "ana-1389-revised", "ana-1389-status"]) {
        await seedPromotedAnalysis(db, id);
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);
  },
);
