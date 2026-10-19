/**
 * #1202 — the structured requirement → `Requirement` row pairing, proven
 * against a REAL SQLite database built from the migration chain:
 *
 *   - the migration added three nullable columns with no default;
 *   - promotion writes the pairing on each row it creates;
 *   - clarification answers join on it: a neighbour renamed to the answered
 *     requirement's exact title — which wins the title match — does not take
 *     the answers;
 *   - a re-run's replacement hard-deletes the rows, and their pairing with them.
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

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

const { persistRequirements } = await import("../src/lib/analysis/analysis-service.js");
const { promoteApprovedRequirements } = await import("../src/lib/analysis/promote-requirements.js");
const { applyClarificationsToRequirements, CLARIFICATIONS_START } =
  await import("../src/lib/analysis/clarification-enrichment.js");
const { synthesisItemKey } = await import("../src/lib/analysis/promotion-pairing.js");

const PROJECT = "proj-1202";
const USER = "u-1202";
const CLARIFIED = "ana-1202-clarified";
const RERUN = "ana-1202-rerun";
const RUN_ID = "extraction-run-1202";

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
// The #1031 neighbours: R5's description holds every word of R6's title.
const R5 = structured(
  "REQ-5",
  "Mark all items up to here as read",
  "Mark every entry older than the selected one as read in a single action.",
);
const R6 = structured(
  "REQ-6",
  "Mark all as read older than X",
  "Mark as read all entries older than a chosen age.",
);
const item = (title: string, structuredIds: string[], criterion: string) => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: [criterion],
  structuredIds,
});
const X = item("Mark up to here", ["REQ-5"], "Entries above the selection stay unread.");
const Y = item("Mark older than an age", ["REQ-6"], "The age defaults to seven days.");

async function seedReviewedAnalysis(db: PrismaClient, analysisId: string): Promise<void> {
  await db.analysis.create({
    data: {
      id: analysisId,
      projectId: PROJECT,
      startedById: USER,
      status: "completed",
      metadata: JSON.stringify({
        structuredRequirements: {
          requirements: [R5, R6],
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
      output: JSON.stringify({ summary: "Two requirements.", requirements: [X, Y] }),
    },
  });
  await db.approvalRequest.createMany({
    data: ["REQ-5", "REQ-6"].map((itemId) => ({
      analysisId,
      type: "requirement",
      itemId,
      status: "approved",
      reviewedAt: new Date(),
    })),
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1202 — the promotion pairing on a real database",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1202-requirement-promotion-pairing");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "u", email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      await seedReviewedAnalysis(db, CLARIFIED);
      await seedReviewedAnalysis(db, RERUN);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const pairingOf = async (analysisId: string) =>
      db.requirement.findMany({
        where: { analysisId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          promotedStructuredId: true,
          promotedStructuredRunId: true,
          promotedSynthesisKeys: true,
        },
      });

    it("the migration added three nullable TEXT columns with no default", async () => {
      const columns = await db.$queryRawUnsafe<
        Array<{ name: string; type: string; notnull: number | bigint; dflt_value: unknown }>
      >(`PRAGMA table_info("requirements")`);
      for (const name of [
        "promotedStructuredId",
        "promotedStructuredRunId",
        "promotedSynthesisKeys",
      ]) {
        const column = columns.find((c) => c.name === name);
        expect(column, name).toBeDefined();
        expect(column!.type).toBe("TEXT");
        expect(Number(column!.notnull)).toBe(0);
        expect(column!.dflt_value).toBeNull();
      }
    });

    it("promotion records each row's structured id, run and synthesis items", async () => {
      expect(await promoteApprovedRequirements(CLARIFIED)).toEqual({
        status: "promoted",
        requirementCount: 2,
      });
      const rows = await pairingOf(CLARIFIED);
      expect(
        rows.map((r) => [
          r.title,
          r.promotedStructuredId,
          r.promotedStructuredRunId,
          r.promotedSynthesisKeys,
        ]),
      ).toEqual([
        [R5.title, "REQ-5", RUN_ID, JSON.stringify([synthesisItemKey(X)])],
        [R6.title, "REQ-6", RUN_ID, JSON.stringify([synthesisItemKey(Y)])],
      ]);
    });

    it("answers about R6 reach R6's row even after R5's row was renamed to R6's exact title", async () => {
      const [r5Row, r6Row] = await pairingOf(CLARIFIED);
      // An analyst's renames: by title, R6's answers would now go to R5's row.
      await db.requirement.update({ where: { id: r5Row!.id }, data: { title: R6.title } });
      await db.requirement.update({
        where: { id: r6Row!.id },
        data: { title: "Age-based bulk read" },
      });
      await db.clarificationDialogState.create({
        data: {
          analysisId: CLARIFIED,
          state: JSON.stringify({
            analysisId: CLARIFIED,
            currentRound: 1,
            maxRounds: 3,
            rounds: [
              {
                round: 1,
                questions: [
                  {
                    id: "q1",
                    requirementId: "REQ-6",
                    ambiguityField: "age",
                    question: "What is the default age?",
                    context: "",
                    answer: "Seven days.",
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

      const out = await applyClarificationsToRequirements(CLARIFIED);

      expect(out).toMatchObject({ appliedCount: 1, unattributedCount: 0 });
      const bodies = await db.requirement.findMany({
        where: { id: { in: [r5Row!.id, r6Row!.id] } },
        select: { id: true, body: true },
      });
      const bodyOf = (id: string) => bodies.find((b) => b.id === id)!.body;
      expect(bodyOf(r6Row!.id)).toContain("Seven days.");
      expect(bodyOf(r5Row!.id)).not.toContain(CLARIFICATIONS_START);
    });

    it("a re-run's replacement hard-deletes the rows, and their pairing with them", async () => {
      await promoteApprovedRequirements(RERUN);
      const promoted = await pairingOf(RERUN);
      expect(promoted.every((r) => r.promotedStructuredId !== null)).toBe(true);

      // A re-run that does not go through the checkpoint replaces the set.
      await persistRequirements({
        analysisId: RERUN,
        projectId: PROJECT,
        synthesis: {
          summary: "A re-run.",
          requirements: [
            {
              type: "feature",
              title: "A requirement from the re-run",
              body: "Body.",
              priority: "medium",
              labels: [],
              evidenceFindingIndexes: [],
              acceptanceCriteria: [],
            },
          ],
        },
        findingIdsByIndex: [],
      });

      const after = await pairingOf(RERUN);
      expect(after.map((r) => r.id)).not.toEqual(expect.arrayContaining([promoted[0]!.id]));
      expect(after).toEqual([
        {
          id: expect.any(String),
          title: "A requirement from the re-run",
          promotedStructuredId: null,
          promotedStructuredRunId: null,
          promotedSynthesisKeys: null,
        },
      ]);
    });
  },
);
