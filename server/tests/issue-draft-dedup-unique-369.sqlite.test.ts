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

    // #395 — two same-titled requirements in ONE analysis, and a re-run of that
    // analysis, which hard-deletes and re-creates its requirement rows.
    it("keeps one draft per same-titled requirement across a re-run of the analysis", async () => {
      await db.analysis.create({ data: { id: "an_twin", projectId: "p1", startedById: "u1" } });
      const createRequirements = async (suffix: string) => {
        for (const [key, body] of [
          ["one", "Password body"],
          ["two", "Passkey body"],
        ]) {
          await db.requirement.create({
            data: {
              id: `req_${key}${suffix}`,
              projectId: "p1",
              analysisId: "an_twin",
              title: "Sign in",
              body,
              createdAt: new Date(key === "one" ? T0 : T1),
            },
          });
        }
      };
      const features = () =>
        db.issueDraft.findMany({
          where: { projectId: "p1", title: { startsWith: "[Feature] Sign in" }, deletedAt: null },
          orderBy: { title: "asc" },
        });
      const opts = {
        projectId: "p1",
        analysisId: "an_twin",
        targetOwner: "acme",
        targetRepo: "metis",
      };

      await createRequirements("");
      await generateDrafts(opts);
      const first = await features();
      expect(first.map((d) => [d.title, d.requirementId])).toEqual([
        ["[Feature] Sign in", "req_one"],
        ["[Feature] Sign in (2)", "req_two"],
      ]);
      expect(first[0].body).toContain("Password body");
      expect(first[1].body).toContain("Passkey body");

      // What persistRequirements does on a re-run: the FK nulls the drafts' link.
      await db.requirement.deleteMany({ where: { analysisId: "an_twin" } });
      expect((await features()).map((d) => d.requirementId)).toEqual([null, null]);
      await createRequirements("_v2");
      const rerun = await generateDrafts(opts);
      expect(rerun.upserted).toBe(0);
      expect(rerun.refreshed).toBe(3);

      const after = await features();
      expect(after.map((d) => d.id)).toEqual(first.map((d) => d.id));
      expect(after.map((d) => d.requirementId)).toEqual(["req_one_v2", "req_two_v2"]);
      expect(after[0].body).toContain("Password body");
      expect(after[1].body).toContain("Passkey body");
    });

    // #490 — a re-run whose synthesis emits the same-titled twins in the other
    // order must not swap their drafts: each published issue keeps its own text.
    describe("#490 — same-titled twins re-run in swapped order", () => {
      const opts = { projectId: "p1", targetOwner: "acme", targetRepo: "metis" };
      const setUp = async (analysisId: string, title: string) => {
        await db.analysis.create({ data: { id: analysisId, projectId: "p1", startedById: "u1" } });
        const createRequirements = async (
          suffix: string,
          rows: Array<{ key: string; body: string; at: string }>,
        ) => {
          for (const r of rows) {
            await db.requirement.create({
              data: {
                id: `${analysisId}_${r.key}${suffix}`,
                projectId: "p1",
                analysisId,
                title,
                body: r.body,
                createdAt: new Date(r.at),
              },
            });
          }
        };
        const features = () =>
          db.issueDraft.findMany({
            where: {
              projectId: "p1",
              title: { startsWith: `[Feature] ${title}` },
              deletedAt: null,
            },
            orderBy: { title: "asc" },
          });
        await createRequirements("", [
          { key: "one", body: "Password body", at: T0 },
          { key: "two", body: "Passkey body", at: T1 },
        ]);
        await generateDrafts({ ...opts, analysisId });
        const first = await features();
        expect(first.map((d) => d.requirementId)).toEqual([
          `${analysisId}_one`,
          `${analysisId}_two`,
        ]);
        await db.issueDraft.updateMany({
          where: { id: { in: first.map((d) => d.id) } },
          data: { status: "published" },
        });
        // What persistRequirements does on a re-run.
        await db.requirement.deleteMany({ where: { analysisId } });
        return { first, features, createRequirements };
      };

      it("keeps each published draft's text and re-links it to its own requirement", async () => {
        const { first, features, createRequirements } = await setUp("an_swap", "Enrol");
        // The re-run emits the twins in the other order.
        await createRequirements("_v2", [
          { key: "one", body: "Password body", at: T1 },
          { key: "two", body: "Passkey body", at: T0 },
        ]);
        const rerun = await generateDrafts({ ...opts, analysisId: "an_swap" });
        expect(rerun.upserted).toBe(0);

        const after = await features();
        expect(after.map((d) => d.id)).toEqual(first.map((d) => d.id));
        expect(after.map((d) => d.requirementId)).toEqual(["an_swap_one_v2", "an_swap_two_v2"]);
        expect(after[0].body).toContain("Password body");
        expect(after[0].body).not.toContain("Passkey body");
        expect(after[1].body).toContain("Passkey body");
        expect(after.map((d) => d.status)).toEqual(["published", "published"]);
      });

      it("never rewrites a published draft's body when the twins' text changed too", async () => {
        const { first, features, createRequirements } = await setUp("an_edit", "Recover");
        await createRequirements("_v2", [
          { key: "one", body: "Password body, reworded", at: T1 },
          { key: "two", body: "Passkey body, reworded", at: T0 },
        ]);
        await generateDrafts({ ...opts, analysisId: "an_edit" });

        const after = await features();
        expect(after.map((d) => d.id)).toEqual(first.map((d) => d.id));
        expect(after.map((d) => d.body)).toEqual(first.map((d) => d.body));
        // No key matches, so the links follow the re-run's order (best-effort,
        // see the #490 note on claimTitle): each draft is linked, to a distinct
        // requirement of the re-run.
        expect([...after.map((d) => d.requirementId)].sort()).toEqual([
          "an_edit_one_v2",
          "an_edit_two_v2",
        ]);

        // Generate is repeatable (POST /drafts/generate). The drafts are linked
        // now, so the hold must outlast the re-link: a second and third run
        // still leave each published body with its own text.
        for (let run = 0; run < 2; run++) {
          await generateDrafts({ ...opts, analysisId: "an_edit" });
          const again = await features();
          expect(again.map((d) => d.body)).toEqual(first.map((d) => d.body));
          expect(again[0].body).not.toContain("Passkey");
          expect(again[1].body).not.toContain("Password");
          expect(again.map((d) => d.status)).toEqual(["published", "published"]);
        }
      });

      it("releases the hold once the requirement's text matches the draft again", async () => {
        const { first, features, createRequirements } = await setUp("an_back", "Reset");
        await createRequirements("_v2", [
          { key: "one", body: "Password body, reworded", at: T0 },
          { key: "two", body: "Passkey body, reworded", at: T1 },
        ]);
        await generateDrafts({ ...opts, analysisId: "an_back" });
        expect((await features()).map((d) => d.body)).toEqual(first.map((d) => d.body));

        // A third run whose synthesis restores the original text.
        await db.requirement.deleteMany({ where: { analysisId: "an_back" } });
        await createRequirements("_v3", [
          { key: "one", body: "Password body", at: T0 },
          { key: "two", body: "Passkey body", at: T1 },
        ]);
        await generateDrafts({ ...opts, analysisId: "an_back" });
        const after = await features();
        expect(after.map((d) => d.requirementId)).toEqual(["an_back_one_v3", "an_back_two_v3"]);
        const meta = after.map((d) => JSON.parse(d.metadata ?? "{}") as Record<string, unknown>);
        expect(meta.map((m) => m.bodyHeld)).toEqual([undefined, undefined]);
      });
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
