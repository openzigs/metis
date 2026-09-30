/**
 * Issue #396 — the read-only report of what #369's dedup migration left behind,
 * run over the shared #402 fixture in a REAL SQLite built by the real migration
 * chain: once with only #369 applied, then again after #402.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findDedupLeftovers,
  formatDedupLeftovers,
  type DedupLeftovers,
  type DedupLeftoversPrisma,
} from "../src/lib/publishing/dedup-leftovers.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  DRAFTS,
  MIGRATION_369,
  MIGRATION_402,
  PROJECT_IDS,
  SEED_TIME,
  USER_ID,
} from "./helpers/draft-dedup-fixture.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

// published_issues rows: [id, batchId, draftId, issueNumber, status, destination]
const ISSUES: Array<[string, string, string, number, string, string]> = [
  // The two published drafts of group h3: d_p1 is kept, d_p2 retired.
  ["pi_p1", "b1", "d_p1", 10, "created", "github"],
  ["pi_p2", "b1", "d_p2", 11, "created", "github"],
  ["pi_p2j", "b2", "d_p2", 7, "updated", "jira"],
  // A retiree of p1/h1 (kept: d_c). p2 has a live h1 draft too (d_other),
  // which must never be named as its survivor (pinned deterministically by the
  // edge-case suite below, which does not depend on row order).
  ["pi_b", "b2", "d_b", 12, "updated", "github"],
  // A failed publish left no remote issue.
  ["pi_a", "b2", "d_a", 0, "failed", "github"],
  // A live draft's issue is not a leftover.
  ["pi_c", "b1", "d_c", 13, "created", "github"],
];

const EXPECTED_PUBLISHED: DedupLeftovers["publishedRetirees"] = [
  {
    projectId: "p1",
    retiredDraftId: "d_b",
    survivorDraftId: "d_c",
    title: "T",
    issues: [{ destination: "github", issueNumber: 12, htmlUrl: "https://gh/12", batchId: "b2" }],
  },
  {
    projectId: "p1",
    retiredDraftId: "d_p2",
    survivorDraftId: "d_p1",
    title: "T",
    issues: [
      { destination: "jira", issueNumber: 7, htmlUrl: "https://gh/7", batchId: "b2" },
      { destination: "github", issueNumber: 11, htmlUrl: "https://gh/11", batchId: "b1" },
    ],
  },
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#396 — report of #369's leftovers (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const report = () => findDedupLeftovers(db as unknown as DedupLeftoversPrisma);

    beforeAll(() => {
      sqlite = createMigratedSqlite("396-leftovers", { stopBefore: MIGRATION_369 });
      const x = sqlite.exec;
      x(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES (?, ?, 'U1', 'u1@example.test', ?, ?)`,
        [USER_ID, USER_ID, SEED_TIME, SEED_TIME],
      );
      for (const p of PROJECT_IDS) {
        x(
          `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt)
           VALUES (?, 'Apollo', ?, ?, ?, ?)`,
          [p, `slug-${p}`, USER_ID, SEED_TIME, SEED_TIME],
        );
      }
      for (const r of DRAFTS) {
        x(
          `INSERT INTO issue_drafts
             (id, projectId, parentDraftId, title, body, status, dedupHash, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, 'T', 'B', ?, ?, ?, ?, ?)`,
          [
            r.id,
            r.projectId,
            r.parentDraftId,
            r.status,
            r.dedupHash,
            r.createdAt,
            r.createdAt,
            r.deletedAt,
          ],
        );
      }
      for (const b of ["b1", "b2"]) {
        x(
          `INSERT INTO publish_batches
             (id, projectId, status, targetOwner, targetRepo, archived, startedById, createdAt, updatedAt)
           VALUES (?, 'p1', 'completed', 'acme', 'metis', 0, ?, ?, ?)`,
          [b, USER_ID, SEED_TIME, SEED_TIME],
        );
      }
      for (const [id, batchId, draftId, n, status, destination] of ISSUES) {
        x(
          `INSERT INTO published_issues
             (id, batchId, draftId, issueNumber, issueId, htmlUrl, status, destination, publishedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            batchId,
            draftId,
            n,
            `node_${id}`,
            `https://gh/${n}`,
            status,
            destination,
            SEED_TIME,
          ],
        );
      }
      sqlite.apply(MIGRATION_369);
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("after #369 alone: names published retirees, and children #402 would repoint", async () => {
      const r = await report();
      // Retired by #369: d_a, d_b, d_e, d_f, d_p2, d_s1. The fixture's d_gone
      // was soft-deleted beforehand, which no application path does, so the
      // "soft-deleted with a live twin" rule counts it as well.
      expect(r.retiredCount).toBe(7);
      expect(r.publishedRetirees).toEqual(EXPECTED_PUBLISHED);
      expect(r.orphanedChildren).toEqual([
        {
          projectId: "p1",
          draftId: "c_live",
          retiredParentId: "d_e",
          repair: "survivor",
          survivorDraftId: "d_d",
        },
        {
          projectId: "p1",
          draftId: "d_s2",
          retiredParentId: "d_s1",
          repair: "self",
          survivorDraftId: "d_s2",
        },
      ]);
    });

    it("after #402: only the self-parent case is left, and the published retirees stay", async () => {
      sqlite.apply(MIGRATION_402);
      const r = await report();
      expect(r.publishedRetirees).toEqual(EXPECTED_PUBLISHED);
      expect(r.orphanedChildren).toEqual([
        {
          projectId: "p1",
          draftId: "d_s2",
          retiredParentId: "d_s1",
          repair: "self",
          survivorDraftId: "d_s2",
        },
      ]);
    });

    it("changes nothing", async () => {
      const snapshot = async () => ({
        drafts: await db.issueDraft.findMany({ orderBy: { id: "asc" } }),
        issues: await db.publishedIssue.findMany({ orderBy: { id: "asc" } }),
      });
      const before = await snapshot();
      await report();
      expect(await snapshot()).toEqual(before);
    });
  },
);

describe("#396 — findDedupLeftovers edge cases", () => {
  const fake = (deleted: unknown[], live: unknown[]) => {
    const calls: string[] = [];
    const prisma = {
      issueDraft: {
        findMany: async (args: { where: { deletedAt: unknown } }) => {
          calls.push("issueDraft");
          return args.where.deletedAt === null ? live : deleted;
        },
      },
      publishedIssue: {
        findMany: async () => {
          calls.push("publishedIssue");
          return [];
        },
      },
    } as unknown as DedupLeftoversPrisma;
    return { prisma, calls };
  };

  it("reports nothing and stops after one query when nothing is soft-deleted", async () => {
    const { prisma, calls } = fake([], []);
    expect(await findDedupLeftovers(prisma)).toEqual({
      retiredCount: 0,
      publishedRetirees: [],
      orphanedChildren: [],
    });
    expect(calls).toEqual(["issueDraft"]);
  });

  it("does not count a soft-deleted draft with no live twin as a retiree", async () => {
    const { prisma, calls } = fake(
      [{ id: "x", projectId: "p1", dedupHash: "h1", title: "T" }],
      [{ id: "y", projectId: "p2", dedupHash: "h1" }],
    );
    expect((await findDedupLeftovers(prisma)).retiredCount).toBe(0);
    expect(calls).toEqual(["issueDraft", "issueDraft"]);
  });
});

describe("#396 — formatDedupLeftovers", () => {
  it("says there is nothing to do on a clean database", () => {
    expect(
      formatDedupLeftovers({ retiredCount: 0, publishedRetirees: [], orphanedChildren: [] }),
    ).toBe(
      [
        "0 draft(s) retired by the #369 dedup migration.",
        "0 retired draft(s) still have a published issue.",
        "0 live draft(s) name a retired parent.",
      ].join("\n"),
    );
  });

  it("lists each duplicate issue and each orphaned child", () => {
    const text = formatDedupLeftovers({
      retiredCount: 3,
      publishedRetirees: [EXPECTED_PUBLISHED[1]],
      orphanedChildren: [
        {
          projectId: "p1",
          draftId: "c_live",
          retiredParentId: "d_e",
          repair: "survivor",
          survivorDraftId: "d_d",
        },
        {
          projectId: "p1",
          draftId: "d_s2",
          retiredParentId: "d_s1",
          repair: "self",
          survivorDraftId: "d_s2",
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "3 draft(s) retired by the #369 dedup migration.",
      "1 retired draft(s) still have a published issue (close the duplicate if it is unwanted):",
      '  project p1: draft d_p2 (kept: d_p1) "T"',
      "    jira #7 https://gh/7",
      "    github #11 https://gh/11",
      "2 live draft(s) name a retired parent:",
      "  project p1: draft c_live -> d_e (apply migration #402 to repoint to d_d)",
      "  project p1: draft d_s2 -> d_s1 (it is the kept draft; shown as parentless)",
    ]);
  });
});
