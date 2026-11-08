/**
 * #2011 — a resumed repository's completed pass replaces that repository's
 * earlier `code` rows in ONE transaction (`persistAgentResult` mode
 * `"supersede"`).
 *
 * #2003 appended the pass's row and then deleted the connector's earlier rows
 * in a second write. A delete that threw after the append left the repository's
 * findings doubled until the next resume, and a read between the two writes saw
 * both sets. Here the two writes run against a real migrated SQLite database, a
 * write inside the transaction is made to fail, and the result is read back
 * through `readFlattenedFindings` (what synthesis reads), never through the
 * object the write returned.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { AgentOutput } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import { IDS, seedAgentsFixture } from "./helpers/agents-fixture.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "sqlite",
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { persistAgentResult, readFlattenedFindings } =
  await import("../src/lib/analysis/analysis-service.js");

const ANALYSIS = "an-2011";
const OTHER_ANALYSIS = "an-2011-other";

const output = (title: string): AgentOutput => ({
  agentKey: "code",
  summary: title,
  notes: [],
  findings: [
    {
      category: "security",
      severity: "high",
      title,
      body: `${title} body`,
      citations: [],
      tags: [],
    },
  ],
});

/**
 * The real client, except that inside a transaction `finding.create` throws:
 * the write fails after the delete and the row have both been issued, so only
 * a rollback can put the earlier rows back.
 */
function failingFindingWrites(db: PrismaClient): PrismaClient {
  const failingTx = (tx: object) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "finding") {
          return {
            create: async () => {
              throw new Error("disk I/O error");
            },
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (fn: (tx: object) => Promise<unknown>) =>
          target.$transaction((tx) => fn(failingTx(tx)));
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2011 — a resumed pass replaces its repository's earlier code rows atomically (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2011-resume-supersede");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      await seedAgentsFixture(db);
      for (const id of [ANALYSIS, OTHER_ANALYSIS]) {
        await db.analysis.create({
          data: { id, projectId: IDS.project, startedById: IDS.alice, status: "completed" },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** Rows the regenerate and continuation before the resume left behind. */
    beforeEach(async () => {
      state.db = db;
      await db.agentResult.deleteMany({});
      const earlier = (title: string, analysisId: string, connectorId?: string) =>
        persistAgentResult({
          analysisId,
          agentKey: "code",
          status: "completed",
          output: output(title),
          startedAt: new Date(Date.now() - 60_000),
          completedAt: new Date(Date.now() - 60_000),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          ...(connectorId ? { connectorId } : {}),
          mode: "append",
        });
      await earlier("c2 first pass", ANALYSIS, "c2");
      await earlier("c2 continuation", ANALYSIS, "c2");
      await earlier("c1 pass", ANALYSIS, "c1");
      await earlier("other analysis c2", OTHER_ANALYSIS, "c2");
    });

    const resumedPass = () =>
      persistAgentResult({
        analysisId: ANALYSIS,
        agentKey: "code",
        status: "completed",
        output: output("c2 resumed"),
        startedAt: new Date(),
        completedAt: new Date(),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        connectorId: "c2",
        mode: "supersede",
      });

    const titles = async (analysisId: string) =>
      (await readFlattenedFindings(analysisId)).map((f) => f.title).sort();

    it("replaces only the resumed connector's own earlier rows", async () => {
      await resumedPass();

      expect(await titles(ANALYSIS)).toEqual(["c1 pass", "c2 resumed"]);
      expect(await titles(OTHER_ANALYSIS)).toEqual(["other analysis c2"]);
    });

    it("a write that fails inside the transaction leaves the earlier rows, and no new one", async () => {
      state.db = failingFindingWrites(db);

      await expect(resumedPass()).rejects.toThrow("disk I/O error");

      state.db = db;
      expect(await titles(ANALYSIS)).toEqual(["c1 pass", "c2 continuation", "c2 first pass"]);
      expect(await db.agentResult.count({ where: { analysisId: ANALYSIS } })).toBe(3);
    });
  },
);
