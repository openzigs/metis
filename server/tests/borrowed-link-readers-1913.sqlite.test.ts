/**
 * #1913 (epic #1828) — the two readers #1902 left taking a borrowed code link
 * (`similar-requirement`, #1839) without a label:
 *
 *   - the reverse lookup `getRequirementsForFile` (`GET …/traceability/by-file`)
 *     returns bare requirement ids, so it cannot say "borrowed": a requirement
 *     that only borrowed a link into the file does not implement it;
 *   - chat's `list_requirements` reports `codeLinks` per requirement: a borrowed
 *     link is no code link of the requirement's own. `get_requirement` still
 *     lists it, with its source, so the model can see the suggestion there.
 *
 * Real SQLite from the migration chain, with a requirement holding only a
 * borrowed link into the file its origin links.
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

const { getRequirementsForFile } = await import("../src/lib/traceability/traceability-spine.js");
const { createGetRequirementTool, createListRequirementsTool } =
  await import("../src/lib/requirements/requirements-chat-tools.js");

const USER = "u1913";
const WS = "ws1913";
const PROJECT = "p1913";
const RUN = "run-1913";
/** Holds its own link into FILE. */
const ORIGIN = "r1913-origin";
/** Holds only a link into FILE borrowed from ORIGIN. */
const BORROWER = "r1913-borrower";
const FILE = "internal/pay/charge.go";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1913 — the reverse file lookup and chat's code-link count leave borrowed links out (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1913-borrowed-link-readers");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1913@x.test" },
      });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER, workspaceId: WS },
      });
      await db.analysis.create({
        data: { id: RUN, projectId: PROJECT, startedById: USER, status: "completed" },
      });
      for (const [id, title] of [
        [ORIGIN, "Charge the card"],
        [BORROWER, "Charge the card on renewal"],
      ] as const) {
        await db.requirement.create({
          data: { id, analysisId: RUN, projectId: PROJECT, title, body: `${title}.` },
        });
      }
      for (const [requirementId, borrowed] of [
        [ORIGIN, false],
        [BORROWER, true],
      ] as const) {
        await db.requirementCodeMapping.create({
          data: {
            requirementId,
            projectId: PROJECT,
            filePath: FILE,
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

    it("the reverse file lookup names the requirement that links the file, not the one that borrowed it", async () => {
      expect(await getRequirementsForFile(PROJECT, FILE, { prisma: db as never })).toEqual([
        ORIGIN,
      ]);
    });

    it("chat's list_requirements counts no borrowed link as a code link", async () => {
      const tool = createListRequirementsTool({
        prisma: db as never,
        semantic: async () => [],
      });
      const res = await tool.exec({}, { sessionId: "s", userId: USER, projectId: PROJECT });
      const counts = Object.fromEntries(
        (res.data as { requirements: Array<{ id: string; codeLinks: number }> }).requirements.map(
          (r) => [r.id, r.codeLinks],
        ),
      );
      expect(counts).toEqual({ [ORIGIN]: 1, [BORROWER]: 0 });
      expect(res.text).toContain(`[${BORROWER}] Charge the card on renewal`);
      expect(res.text).toMatch(new RegExp(`\\[${BORROWER}\\][^\\n]* code links: 0;`));
    });

    it("chat's get_requirement names a borrowed link as borrowed, so it never contradicts the list's count", async () => {
      const tool = createGetRequirementTool({ prisma: db as never });
      const res = await tool.exec(
        { requirementId: BORROWER },
        { sessionId: "s", userId: USER, projectId: PROJECT },
      );
      expect(res.text).toContain(
        `- ${FILE}:10-30 (borrowed from Charge the card, not yet checked by analysis)`,
      );
      expect(res.text).not.toContain("(similar-requirement)");
    });
  },
);
