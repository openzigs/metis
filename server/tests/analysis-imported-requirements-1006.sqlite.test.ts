/**
 * #1006 — the imported-requirement queries, proven against a REAL SQLite
 * database built from the migration chain. The route test's mock evaluates the
 * `where` it is given; this one has no mock at all, so the production predicates
 * (`externalSource: { not: null }`, project scope, soft delete, `q`) are what
 * decide every assertion.
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

const {
  listImportedRequirements,
  loadSelectedImportedRequirements,
  IMPORTED_REQUIREMENT_LIST_LIMIT,
} = await import("../src/lib/analysis/imported-requirement-input.js");

const PROJECT = "proj-1006";
const OTHER = "proj-1006-other";
const ANALYSIS = "ana-1006";
const OTHER_ANALYSIS = "ana-1006-other";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1006 — imported-requirement queries on a real database",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const T0 = Date.UTC(2026, 0, 1);
    const row = (
      id: string,
      title: string,
      opts: {
        projectId?: string;
        externalSource?: string | null;
        externalId?: string | null;
        deleted?: boolean;
        minutes?: number;
      } = {},
    ) => ({
      id,
      projectId: opts.projectId ?? PROJECT,
      analysisId: (opts.projectId ?? PROJECT) === PROJECT ? ANALYSIS : OTHER_ANALYSIS,
      title,
      body: "",
      externalSource: opts.externalSource === undefined ? "github" : opts.externalSource,
      externalId: opts.externalId === undefined ? id.replace(/\D/g, "") : opts.externalId,
      createdAt: new Date(T0 + (opts.minutes ?? 0) * 60_000),
      deletedAt: opts.deleted ? new Date(T0) : null,
    });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1006-imported-requirements");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1006", username: "u-1006", displayName: "u", email: "u-1006@example.test" },
      });
      for (const [id, analysisId] of [
        [PROJECT, ANALYSIS],
        [OTHER, OTHER_ANALYSIS],
      ] as const) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: "u-1006" } });
        await db.analysis.create({
          data: { id: analysisId, projectId: id, startedById: "u-1006", status: "completed" },
        });
      }
      await db.requirement.createMany({
        data: [
          // The oldest imported row: pushed past the cap by the bulk rows below.
          row("req-3401", "Mark all entries as read", { minutes: 0 }),
          row("req-synth-1", "A synthesized requirement", {
            externalSource: null,
            externalId: null,
            minutes: 1,
          }),
          row("req-deleted-9", "Deleted imported item", { deleted: true, minutes: 2 }),
          row("req-foreign-7", "Foreign project item", { projectId: OTHER, minutes: 3 }),
          ...Array.from({ length: IMPORTED_REQUIREMENT_LIST_LIMIT }, (_, i) =>
            row(`req-bulk-${10_000 + i}`, `Bulk item ${i}`, { minutes: 10 + i }),
          ),
        ],
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists only this project's live imported rows, newest first, and says it is cut", async () => {
      const res = await listImportedRequirements(PROJECT);
      const ids = res.items.map((i) => i.id);
      expect(res.items).toHaveLength(IMPORTED_REQUIREMENT_LIST_LIMIT);
      expect(res).toMatchObject({ total: IMPORTED_REQUIREMENT_LIST_LIMIT + 1, truncated: true });
      expect(ids[0]).toBe(`req-bulk-${10_000 + IMPORTED_REQUIREMENT_LIST_LIMIT - 1}`);
      expect(ids).not.toContain("req-3401");
    });

    it("never lists a requirement that was not imported, a deleted one, or another project's", async () => {
      for (const q of ["synthesized", "Deleted", "Foreign"]) {
        expect(await listImportedRequirements(PROJECT, q)).toEqual({
          items: [],
          total: 0,
          truncated: false,
        });
      }
    });

    it("reaches the row past the cap by title, case-insensitively, or by issue number", async () => {
      for (const q of ["mark all", "MARK ALL", "3401"]) {
        const res = await listImportedRequirements(PROJECT, q);
        expect(res.items.map((i) => i.id)).toEqual(["req-3401"]);
        expect(res).toMatchObject({ total: 1, truncated: false });
      }
    });

    it("loads a selected imported row past the cap", async () => {
      const [item] = await loadSelectedImportedRequirements(PROJECT, ["req-3401"]);
      expect(item).toMatchObject({ id: "req-3401", externalSource: "github", externalId: "3401" });
    });

    it.each([
      ["a requirement that was not imported", "req-synth-1"],
      ["a deleted imported requirement", "req-deleted-9"],
      ["another project's imported requirement", "req-foreign-7"],
    ])("404s %s", async (_label, id) => {
      await expect(loadSelectedImportedRequirements(PROJECT, [id])).rejects.toMatchObject({
        statusCode: 404,
        code: "IMPORTED_REQUIREMENT_NOT_FOUND",
      });
    });
  },
);
