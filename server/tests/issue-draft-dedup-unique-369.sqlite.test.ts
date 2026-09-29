/**
 * Issue #369 — one live draft per (projectId, dedupHash), against a REAL SQLite
 * database built by the real migration chain.
 *
 * The mocked generator suite proves the claim-and-retry logic; only a real
 * database proves the partial unique index exists, that it ignores soft-deleted
 * rows, that the migration retires pre-existing duplicates instead of failing
 * on them, and that two analyses with a same-titled requirement end up with two
 * feature drafts when every read goes through the production queries.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

// The exporter's batch calls are stubbed: the drafts it writes are the subject.
const publishing = vi.hoisted(() => ({ createBatch: vi.fn(), executeBatch: vi.fn() }));
vi.mock("../src/lib/publishing/publishing-service.js", () => publishing);

const { generateDrafts } = await import("../src/lib/publishing/draft-generator.js");
const { exportSuggestionsToGithub } =
  await import("../src/lib/testcoverage/exporters/github-exporter.js");

const MIGRATION = "20261001000000_issue369_issue_draft_dedup_unique";
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";

function draftRows(file: string): Array<{ id: string; deletedAt: unknown }> {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(`SELECT id, deletedAt FROM issue_drafts ORDER BY id`).all() as Array<{
      id: string;
      deletedAt: unknown;
    }>;
  } finally {
    db.close();
  }
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#369 — issue_drafts (projectId, dedupHash) is unique among live rows (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(() => {
      sqlite = createMigratedSqlite("369-dedup", { stopBefore: MIGRATION });
      const x = sqlite.exec;
      x(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      for (const p of ["p1", "p2"]) {
        x(
          `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt)
           VALUES (?, 'Apollo', ?, 'u1', ?, ?)`,
          [p, `slug-${p}`, T0, T0],
        );
      }
      const draft = (
        id: string,
        project: string,
        hash: string,
        status: string,
        createdAt: string,
        deletedAt: string | null = null,
      ) =>
        x(
          `INSERT INTO issue_drafts (id, projectId, title, body, status, dedupHash, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, 'T', 'B', ?, ?, ?, ?, ?)`,
          [id, project, status, hash, createdAt, createdAt, deletedAt],
        );
      // Group h1/p1: the published row is the survivor even though it is newest.
      draft("d_a", "p1", "h1", "draft", T0);
      draft("d_b", "p1", "h1", "approved", T0);
      draft("d_c", "p1", "h1", "published", T1);
      draft("d_gone", "p1", "h1", "draft", T0, T0);
      // Group h2/p1: no published row, so the oldest (then lowest id) survives.
      draft("d_e", "p1", "h2", "draft", T1);
      draft("d_d", "p1", "h2", "draft", T0);
      draft("d_f", "p1", "h2", "draft", T0);
      // Same hash in another project is not a duplicate.
      draft("d_other", "p2", "h1", "draft", T0);
      sqlite.apply(MIGRATION);
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("retires pre-existing live duplicates, keeping the published or else the oldest", () => {
      const live = draftRows(sqlite.dbFile)
        .filter((r) => r.deletedAt === null)
        .map((r) => r.id);
      expect(live).toEqual(["d_c", "d_d", "d_other"]);
      // A row that was already soft-deleted keeps its original timestamp.
      const gone = draftRows(sqlite.dbFile).find((r) => r.id === "d_gone");
      expect(gone?.deletedAt).not.toBeNull();
    });

    it("rejects a second live draft with the same (projectId, dedupHash)", async () => {
      await expect(
        db.issueDraft.create({
          data: { projectId: "p1", title: "T", body: "B", dedupHash: "h1" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("allows a live draft whose only duplicate is soft-deleted", async () => {
      await db.issueDraft.create({
        data: { projectId: "p2", title: "T", body: "B", dedupHash: "h9", deletedAt: new Date() },
      });
      const live = await db.issueDraft.create({
        data: { projectId: "p2", title: "T", body: "B", dedupHash: "h9" },
      });
      expect(live.deletedAt).toBeNull();
    });

    it("gives two analyses with a same-titled requirement separate feature drafts", async () => {
      for (const a of ["an_a", "an_b"]) {
        await db.analysis.create({ data: { id: a, projectId: "p1", startedById: "u1" } });
        await db.requirement.create({
          data: {
            id: `req_${a}`,
            projectId: "p1",
            analysisId: a,
            title: "User login",
            body: `Body from ${a}`,
          },
        });
      }
      const opts = { projectId: "p1", targetOwner: "acme", targetRepo: "metis" };
      await generateDrafts({ ...opts, analysisId: "an_a" });
      const featureA = await db.issueDraft.findFirstOrThrow({
        where: { requirementId: "req_an_a" },
      });
      await db.issueDraft.update({ where: { id: featureA.id }, data: { status: "published" } });

      await generateDrafts({ ...opts, analysisId: "an_b" });
      const rerun = await generateDrafts({ ...opts, analysisId: "an_b" });
      expect(rerun.refreshed).toBe(2);
      expect(rerun.upserted).toBe(0);

      const afterA = await db.issueDraft.findUniqueOrThrow({ where: { id: featureA.id } });
      expect(afterA.body).toContain("Body from an_a");
      expect(afterA.body).not.toContain("Body from an_b");
      expect(JSON.parse(afterA.metadata ?? "{}").analysisId).toBe("an_a");
      const featureB = await db.issueDraft.findFirstOrThrow({
        where: { requirementId: "req_an_b", deletedAt: null },
      });
      expect(featureB.id).not.toBe(featureA.id);
      expect(featureB.title).toBe("[Feature] User login (2)");
      expect(featureB.dedupHash).not.toBe(afterA.dedupHash);
      expect(featureB.body).toContain("Body from an_b");
      expect(featureB.status).toBe("draft");
    });

    it("lets a test-coverage export be retried after createBatch refused the first attempt", async () => {
      const suggestion = (id: string) => ({
        id,
        title: `Case ${id}`,
        gwt: { given: ["g"], when: ["w"], then: ["t"] },
        steps: [],
        priority: "high" as const,
        tags: [],
        mappedRequirementIds: [],
        faithfulness: 0.9,
        lowConfidence: false,
      });
      const opts = { projectId: "p2", targetOwner: "acme", targetRepo: "metis", actorId: "u1" };
      const live = () =>
        db.issueDraft.findMany({
          where: { projectId: "p2", dedupHash: { in: ["sg1", "sg2"] }, deletedAt: null },
          orderBy: { dedupHash: "asc" },
        });

      // First attempt: the drafts are written, then the #619 approval gate refuses the batch.
      publishing.createBatch.mockRejectedValueOnce(
        Object.assign(new Error("approval required"), { status: 409, code: "APPROVAL_REQUIRED" }),
      );
      await expect(
        exportSuggestionsToGithub([suggestion("sg1"), suggestion("sg2")], opts),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      const stranded = await live();
      expect(stranded.map((d) => d.status)).toEqual(["draft", "draft"]);

      // Retry after approval: the stranded drafts are reused, not duplicated.
      publishing.createBatch.mockResolvedValueOnce({ id: "batch-1" });
      const retry = await exportSuggestionsToGithub([suggestion("sg1"), suggestion("sg2")], opts);
      expect(retry.draftIds).toEqual(stranded.map((d) => d.id));
      expect(publishing.createBatch.mock.calls.at(-1)?.[0].input.draftIds).toEqual(
        stranded.map((d) => d.id),
      );

      // A published draft re-exports as a draft again; an in-flight one is left alone.
      await db.issueDraft.update({ where: { id: stranded[0].id }, data: { status: "published" } });
      await db.issueDraft.update({ where: { id: stranded[1].id }, data: { status: "publishing" } });
      publishing.createBatch.mockResolvedValueOnce({ id: "batch-2" });
      await exportSuggestionsToGithub(
        [{ ...suggestion("sg1"), title: "Renamed" }, suggestion("sg2")],
        opts,
      );
      const after = await live();
      expect(after.map((d) => d.id)).toEqual(stranded.map((d) => d.id));
      expect(after.map((d) => d.status)).toEqual(["draft", "publishing"]);
      expect(after[0].title).toBe("Renamed");
    });
  },
);
