/**
 * #1902 (epic #1828) — the readers #1893 left taking every source. A code link
 * borrowed from a similar requirement (`similar-requirement`, #1839) is a
 * hypothesis no analysis has checked, and none of these can say "borrowed":
 *
 *   - "Tested by" (`loadTestedByTargets`, `listUntestedRequirements`): a test
 *     of the borrowed code is no test of this requirement, and a requirement
 *     holding only borrowed links has no mapped code;
 *   - the requirement's chain resolves its tests from its own links only: the
 *     borrowed code node is labelled, a test it reached would not be;
 *   - the workspace coverage rollup (`getWorkspaceTraceabilitySummary`): a
 *     borrowed link maps no code and does not make an imported item analysed.
 *
 * Real SQLite from the migration chain. The borrowed link points at a real Go
 * test case, so each reader that took it would answer differently.
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
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { loadTestedByTargets, listUntestedRequirements } =
  await import("../src/lib/traceability/tested-by.js");
const { getRequirementChain } = await import("../src/lib/traceability/traceability-spine.js");
const { getWorkspaceTraceabilitySummary } =
  await import("../src/lib/traceability/workspace-rollup.js");

const USER = "u1902";
const WS = "ws1902";
const PROJECT = "p1902";
const RUN = "run-1902";
/** Holds its own link to the test case. */
const ORIGIN = "r1902-origin";
/** An imported item holding only a link borrowed from ORIGIN. */
const BORROWER = "r1902-borrower";
/** Holds no link at all. */
const PLAIN = "r1902-plain";
const TEST_FILE = "internal/pay/pay_test.go";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1902 — 'Tested by', the chain's tests and the workspace rollup leave borrowed links out (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1902-borrowed-citation-readers");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1902@x.test" },
      });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "owner" } });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER, workspaceId: WS },
      });
      await db.analysis.create({
        data: { id: RUN, projectId: PROJECT, startedById: USER, status: "completed" },
      });
      await db.codeGraph.create({ data: { id: "graph-1902", projectId: PROJECT } });
      await db.codeSymbol.create({
        data: {
          id: "s-test",
          codeGraphId: "graph-1902",
          projectId: PROJECT,
          kind: "function",
          name: "TestChargeCard",
          qualifiedName: `${TEST_FILE}::TestChargeCard`,
          filePath: TEST_FILE,
          startLine: 10,
          endLine: 30,
          language: "go",
          contentHash: "h-test",
        },
      });
      await db.requirement.create({
        data: {
          id: ORIGIN,
          analysisId: RUN,
          projectId: PROJECT,
          title: "Charge the card",
          body: "Charge the card at checkout.",
          promotedStructuredId: "REQ-1",
        },
      });
      await db.requirement.create({
        data: {
          id: BORROWER,
          analysisId: RUN,
          projectId: PROJECT,
          title: "Charge the card on renewal",
          body: "Imported from the tracker.",
          importSourceId: "src-github",
          externalSource: "github",
          externalId: "GH-1",
        },
      });
      await db.requirement.create({
        data: { id: PLAIN, analysisId: RUN, projectId: PROJECT, title: "Plain", body: "Plain." },
      });
      for (const [requirementId, borrowed] of [
        [ORIGIN, false],
        [BORROWER, true],
      ] as const) {
        await db.requirementCodeMapping.create({
          data: {
            requirementId,
            projectId: PROJECT,
            filePath: TEST_FILE,
            codeSymbolId: "s-test",
            startLine: 10,
            endLine: 30,
            confidence: borrowed ? 0.4 : 0.9,
            source: borrowed ? "similar-requirement" : "manual",
            originRequirementId: borrowed ? ORIGIN : null,
            freshness: "fresh",
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("'Tested by' takes no target from a borrowed link", async () => {
      const targets = await loadTestedByTargets(db as never, PROJECT, [ORIGIN, BORROWER]);
      expect(targets.get(ORIGIN)?.map((t) => t.filePath)).toEqual([TEST_FILE]);
      expect(targets.has(BORROWER)).toBe(false);
    });

    it("the test gaps count a requirement holding only borrowed links as having no code, not as tested", async () => {
      const gaps = await listUntestedRequirements(PROJECT, undefined, { prisma: db as never });
      expect(gaps).toMatchObject({ total: 3, tested: 1, noCode: 2, untested: [] });
    });

    it("the chain shows the borrowed link, labelled, and resolves no test from it", async () => {
      const own = await getRequirementChain(PROJECT, ORIGIN, { prisma: db as never });
      // The fixture's link does reach a test: its absence below is the filter's.
      expect(own.testedBy.map((t) => [t.symbol, t.relation])).toEqual([
        [`${TEST_FILE}::TestChargeCard`, "direct"],
      ]);

      const chain = await getRequirementChain(PROJECT, BORROWER, { prisma: db as never });
      expect(chain.directCode).toEqual([
        expect.objectContaining({
          filePath: TEST_FILE,
          source: "similar-requirement",
          originRequirementLabel: "REQ-1",
        }),
      ]);
      expect(chain.testedBy).toEqual([]);
    });

    it("the workspace rollup counts no borrowed link as mapped code", async () => {
      const summary = await getWorkspaceTraceabilitySummary({ id: USER, role: "admin" }, WS, {
        prisma: db as never,
      });
      expect(summary.projects).toEqual([
        expect.objectContaining({
          projectId: PROJECT,
          requirements: 3,
          // The imported item no analysis mapped stays unanalysed: its borrowed link is no mapping.
          importedUnanalysed: 1,
          analysedRequirements: 2,
          codeCoverage: 0.5,
          codeMappedRequirements: 1,
          testCoverage: 1,
        }),
      ]);
    });
  },
);
