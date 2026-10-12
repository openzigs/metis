/**
 * #1063 — a requirement keeps the imported item it came from, proven against a
 * REAL SQLite database built from the migration chain: the new nullable column
 * exists, `persistRequirements` writes it, and the analysis snapshot resolves
 * it to the imported item's own title and URL.
 *
 * Also proven here: a synthesised requirement is NOT turned into an imported
 * row. `externalSource` / `externalId` stay null on it, so it never appears in
 * the imported-item picker and never collides with the re-import dedup key.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SynthesisOutput } from "@metis/shared";
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

const { persistRequirements, getAnalysisSnapshot } =
  await import("../src/lib/analysis/analysis-service.js");
const { listImportedRequirements } =
  await import("../src/lib/analysis/imported-requirement-input.js");

const PROJECT = "proj-1063";
const IMPORT_ANALYSIS = "ana-1063-import";
const RUN = "ana-1063-run";
const PLAIN_RUN = "ana-1063-plain";

const SOURCES = [
  {
    candidateId: "NR-1",
    requirementId: "req-imp-4478",
    title: "Mark all as read older than X",
    externalSource: "github",
    externalId: "4478",
    externalUrl: "https://github.com/miniflux/v2/issues/4478",
  },
  {
    candidateId: "NR-2",
    requirementId: "req-imp-4074",
    title: "Add a button to terminate all sessions",
    externalSource: "github",
    externalId: "4074",
    externalUrl: "https://github.com/miniflux/v2/issues/4074",
  },
];

const requirement = (title: string, sourceIds?: string[]) => ({
  type: "feature" as const,
  title,
  body: `${title}.`,
  priority: "medium" as const,
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: [],
  ...(sourceIds !== undefined ? { sourceIds } : {}),
});

const synthesis: SynthesisOutput = {
  summary: "Four requirements from two imported items.",
  requirements: [
    requirement("Define and implement time-bounded 'mark all as read older than X'", ["NR-1"]),
    requirement("Define and implement terminate-all-sessions for a user", ["NR-2", "NR-99"]),
    requirement("Complete intake: scope and priority for the feature requests", []),
    requirement("Verify reconciliation of the impacted schema objects"),
  ],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1063 — requirement source items on a real database",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1063-requirement-source-items");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1063", username: "u-1063", displayName: "u", email: "u-1063@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: "u-1063" },
      });
      await db.analysis.create({
        data: {
          id: IMPORT_ANALYSIS,
          projectId: PROJECT,
          startedById: "u-1063",
          status: "completed",
        },
      });
      await db.analysis.create({
        data: {
          id: RUN,
          projectId: PROJECT,
          startedById: "u-1063",
          status: "completed",
          metadata: JSON.stringify({ agentKeys: ["document"], sourceRequirements: SOURCES }),
        },
      });
      await db.analysis.create({
        data: {
          id: PLAIN_RUN,
          projectId: PROJECT,
          startedById: "u-1063",
          status: "completed",
          metadata: JSON.stringify({ agentKeys: ["document"] }),
        },
      });
      await db.requirement.createMany({
        data: SOURCES.map((s) => ({
          id: s.requirementId,
          projectId: PROJECT,
          analysisId: IMPORT_ANALYSIS,
          title: s.title,
          body: "",
          externalSource: s.externalSource,
          externalId: s.externalId,
          externalUrl: s.externalUrl,
        })),
      });
      await persistRequirements({
        analysisId: RUN,
        projectId: PROJECT,
        synthesis,
        findingIdsByIndex: [],
      });
      await persistRequirements({
        analysisId: PLAIN_RUN,
        projectId: PROJECT,
        synthesis,
        findingIdsByIndex: [],
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** Stored column per requirement title (row order is not relied on). */
    const stored = async (analysisId: string): Promise<Record<string, string | null>> =>
      Object.fromEntries(
        (
          await db.requirement.findMany({
            where: { analysisId },
            select: { title: true, sourceCandidateIds: true },
          })
        ).map((r) => [r.title, r.sourceCandidateIds]),
      );

    const T = {
      mark: "Define and implement time-bounded 'mark all as read older than X'",
      terminate: "Define and implement terminate-all-sessions for a user",
      intake: "Complete intake: scope and priority for the feature requests",
      verify: "Verify reconciliation of the impacted schema objects",
    };

    it("the migration added a nullable column with no default", async () => {
      const columns = await db.$queryRawUnsafe<
        Array<{ name: string; type: string; notnull: number | bigint; dflt_value: unknown }>
      >(`PRAGMA table_info("requirements")`);
      const column = columns.find((c) => c.name === "sourceCandidateIds");
      expect(column).toBeDefined();
      expect(column!.type).toBe("TEXT");
      expect(Number(column!.notnull)).toBe(0);
      expect(column!.dflt_value).toBeNull();
    });

    it("leaves every existing (imported) row's column NULL: no backfill", async () => {
      expect(await stored(IMPORT_ANALYSIS)).toEqual({
        [SOURCES[0]!.title]: null,
        [SOURCES[1]!.title]: null,
      });
    });

    it("stores the checked ids, [] for an added requirement, NULL when not said", async () => {
      expect(await stored(RUN)).toEqual({
        [T.mark]: '["NR-1"]',
        // NR-99 is not one of this run's ids and is not stored.
        [T.terminate]: '["NR-2"]',
        [T.intake]: "[]",
        [T.verify]: null,
      });
    });

    it("stores NULL for every requirement of a run not started from imported items", async () => {
      expect(await stored(PLAIN_RUN)).toEqual({
        [T.mark]: null,
        [T.terminate]: null,
        [T.intake]: null,
        [T.verify]: null,
      });
    });

    it("the snapshot gives each requirement the imported item's own title and link", async () => {
      const snapshot = await getAnalysisSnapshot(RUN);
      const byTitle = new Map(snapshot!.requirements.map((r) => [r.title, r.sourceItems]));
      expect(
        byTitle.get("Define and implement time-bounded 'mark all as read older than X'"),
      ).toEqual([SOURCES[0]]);
      expect(byTitle.get("Define and implement terminate-all-sessions for a user")).toEqual([
        SOURCES[1],
      ]);
      // Added by the analysis.
      expect(byTitle.get("Complete intake: scope and priority for the feature requests")).toEqual(
        [],
      );
      // Not recorded: never shown as added.
      expect(byTitle.get("Verify reconciliation of the impacted schema objects")).toBeNull();
      // The run-level list is unchanged.
      expect(snapshot!.sourceRequirements).toEqual(SOURCES);
    });

    it("the snapshot of a plain run carries no source for any requirement", async () => {
      const snapshot = await getAnalysisSnapshot(PLAIN_RUN);
      expect(snapshot!.requirements.map((r) => r.sourceItems)).toEqual([null, null, null, null]);
      expect(snapshot!.sourceRequirements).toBeUndefined();
    });

    it("a synthesised requirement is not made an imported row", async () => {
      const rows = await db.requirement.findMany({
        where: { analysisId: RUN },
        select: { externalSource: true, externalId: true, externalUrl: true, importSourceId: true },
      });
      for (const r of rows) {
        expect(r).toEqual({
          externalSource: null,
          externalId: null,
          externalUrl: null,
          importSourceId: null,
        });
      }
      // The picker still lists exactly the two imported items.
      const listed = await listImportedRequirements(PROJECT);
      expect(listed.items.map((i) => i.id).sort()).toEqual(["req-imp-4074", "req-imp-4478"]);
    });

    it("a re-run that replaces the set rewrites the source too", async () => {
      await persistRequirements({
        analysisId: RUN,
        projectId: PROJECT,
        synthesis: {
          summary: "s",
          requirements: [requirement("Merged session and read-state cleanup", ["NR-2", "NR-1"])],
        },
        findingIdsByIndex: [],
      });
      expect(await stored(RUN)).toEqual({
        "Merged session and read-state cleanup": '["NR-2","NR-1"]',
      });
      const snapshot = await getAnalysisSnapshot(RUN);
      expect(snapshot!.requirements[0]!.sourceItems).toEqual([SOURCES[1], SOURCES[0]]);
    });
  },
);
