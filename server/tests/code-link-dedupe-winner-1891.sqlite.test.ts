/**
 * #1891 — which row of a repeated requirement-to-code link the chain keeps,
 * read back through `getRequirementChain` on a real database: the freshness
 * tier first, then the surer, then the id — never the database's tie order.
 *
 * Real SQLite from the migration chain. The rows are inserted with the larger
 * id first, so a read that left equal rows in the order the database returns
 * them keeps the other row.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import { getRequirementChain } from "../src/lib/traceability/traceability-spine.js";

const USER = "u1891";
const WS = "ws1891";
const PROJECT = "p1891";
const RUN = "run-1891";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1891 — the chain's dedupe winner is deterministic and current-first (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1891-code-link-dedupe-winner");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1891@x.test" },
      });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER, workspaceId: WS },
      });
      await db.analysis.create({
        data: { id: RUN, projectId: PROJECT, startedById: USER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function chainOf(
      requirementId: string,
      rows: Array<{ id: string; confidence: number; source: string; freshness: string }>,
    ) {
      await db.requirement.create({
        data: { id: requirementId, analysisId: RUN, projectId: PROJECT, title: "T", body: "B" },
      });
      for (const r of rows) {
        await db.requirementCodeMapping.create({
          data: { ...r, requirementId, projectId: PROJECT, filePath: "src/login.ts" },
        });
      }
      return getRequirementChain(PROJECT, requirementId, { prisma: db as never });
    }

    it("keeps the row with the smaller id when two rows of one link are equal on rank", async () => {
      const chain = await chainOf("r1891-tie", [
        { id: "m1891-b", confidence: 0.5, source: "analysis-grounding", freshness: "fresh" },
        { id: "m1891-a", confidence: 0.5, source: "semantic", freshness: "fresh" },
      ]);
      expect(chain.directCode.map((c) => c.source)).toEqual(["semantic"]);
    });

    it("keeps the never-checked semantic link over a surer out-of-date citation of the same code", async () => {
      const chain = await chainOf("r1891-stale", [
        { id: "m1891-c", confidence: 0.9, source: "analysis-grounding", freshness: "stale" },
        { id: "m1891-d", confidence: 0.6, source: "semantic", freshness: "unverified" },
      ]);
      expect(chain.directCode.map((c) => [c.source, c.freshness])).toEqual([
        ["semantic", "unverified"],
      ]);
      // The file is still the analysis's grounding (#1969), read before the dedupe.
      expect(chain.groundedFiles).toEqual(["src/login.ts"]);
    });
  },
);
