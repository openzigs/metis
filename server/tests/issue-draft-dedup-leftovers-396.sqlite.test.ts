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
  // A publish that failed before the remote write stored 0 and an empty URL:
  // no remote issue exists, so it is not a leftover.
  ["pi_a", "b2", "d_a", 0, "failed", "github"],
  // #1091: the remote create succeeded and a later step failed, so the row is
  // "failed" but carries the real issue, which still exists (rollback closes
  // it only when more than half the batch failed). It IS a leftover.
  ["pi_e", "b1", "d_e", 14, "failed", "github"],
  // A live draft's issue is not a leftover.
  ["pi_c", "b1", "d_c", 13, "created", "github"],
];

const EXPECTED_PUBLISHED: DedupLeftovers["publishedRetirees"] = [
  {
    projectId: "p1",
    retiredDraftId: "d_b",
    survivorDraftId: "d_c",
    title: "T",
    projectArchived: false,
    issues: [
      {
        destination: "github",
        issueNumber: 12,
        htmlUrl: "https://gh/12",
        batchId: "b2",
        status: "updated",
      },
    ],
  },
  {
    projectId: "p1",
    retiredDraftId: "d_e",
    survivorDraftId: "d_d",
    title: "T",
    projectArchived: false,
    issues: [
      {
        destination: "github",
        issueNumber: 14,
        htmlUrl: "https://gh/14",
        batchId: "b1",
        status: "failed",
      },
    ],
  },
  {
    projectId: "p1",
    retiredDraftId: "d_p2",
    survivorDraftId: "d_p1",
    title: "T",
    projectArchived: false,
    issues: [
      {
        destination: "jira",
        issueNumber: 7,
        htmlUrl: "https://gh/7",
        batchId: "b2",
        status: "updated",
      },
      {
        destination: "github",
        issueNumber: 11,
        htmlUrl: "https://gh/11",
        batchId: "b1",
        status: "created",
      },
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
            n > 0 ? `https://gh/${n}` : "",
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
      // Retired by #369, all at the migration's one CURRENT_TIMESTAMP: d_a,
      // d_b, d_e, d_f, d_p2, d_s1. The fixture's d_gone was soft-deleted
      // beforehand (at T0) and also has a live twin: it is counted, but in its
      // own deletedAt group, so the report never attributes it to #369.
      expect(r.retiredCount).toBe(7);
      expect(r.retiredByDeletedAt).toHaveLength(2);
      expect(r.retiredByDeletedAt[0]).toEqual({ deletedAt: "2026-09-01T00:00:00.000Z", count: 1 });
      expect(r.retiredByDeletedAt[1].count).toBe(6);
      expect(r.retiredByDeletedAt[1].deletedAt > r.retiredByDeletedAt[0].deletedAt).toBe(true);
      expect(r.publishedRetirees).toEqual(EXPECTED_PUBLISHED);
      // The failed row that left no remote issue (d_a, #0) is not listed.
      expect(r.publishedRetirees.map((p) => p.retiredDraftId)).not.toContain("d_a");
      expect(r.orphanedChildren).toEqual([
        {
          projectId: "p1",
          draftId: "c_live",
          retiredParentId: "d_e",
          repair: "survivor",
          survivorDraftId: "d_d",
          projectArchived: false,
        },
        {
          projectId: "p1",
          draftId: "d_s2",
          retiredParentId: "d_s1",
          repair: "self",
          survivorDraftId: "d_s2",
          projectArchived: false,
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
          projectArchived: false,
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
      retiredByDeletedAt: [],
      publishedRetirees: [],
      orphanedChildren: [],
    });
    expect(calls).toEqual(["issueDraft"]);
  });

  it("marks leftovers whose project is archived (soft-deleted)", async () => {
    const at = new Date("2026-09-03T00:00:00.000Z");
    const archived = { deletedAt: new Date("2026-09-04T00:00:00.000Z") };
    const prisma = {
      issueDraft: {
        findMany: async (args: { where: { deletedAt: unknown; parentDraftId?: unknown } }) => {
          if (args.where.parentDraftId) {
            return [
              { id: "k1", projectId: "pa", parentDraftId: "r1", project: archived },
              { id: "k2", projectId: "pl", parentDraftId: "r2", project: { deletedAt: null } },
            ];
          }
          if (args.where.deletedAt === null) {
            return [
              { id: "s1", projectId: "pa", dedupHash: "h" },
              { id: "s2", projectId: "pl", dedupHash: "h" },
            ];
          }
          return [
            {
              id: "r1",
              projectId: "pa",
              dedupHash: "h",
              title: "A",
              deletedAt: at,
              project: archived,
            },
            {
              id: "r2",
              projectId: "pl",
              dedupHash: "h",
              title: "L",
              deletedAt: at,
              project: { deletedAt: null },
            },
          ];
        },
      },
      publishedIssue: {
        findMany: async () => [
          { draftId: "r1", destination: "github", issueNumber: 1, htmlUrl: "u1", batchId: "b" },
          { draftId: "r2", destination: "github", issueNumber: 2, htmlUrl: "u2", batchId: "b" },
        ],
      },
    } as unknown as DedupLeftoversPrisma;
    const r = await findDedupLeftovers(prisma);
    expect(r.publishedRetirees.map((p) => [p.retiredDraftId, p.projectArchived])).toEqual([
      ["r1", true],
      ["r2", false],
    ]);
    expect(r.orphanedChildren.map((c) => [c.draftId, c.projectArchived])).toEqual([
      ["k1", true],
      ["k2", false],
    ]);
    const text = formatDedupLeftovers(r).split("\n");
    expect(text).toContain('  project pa (archived): draft r1 (kept: s1) "A"');
    expect(text).toContain('  project pl: draft r2 (kept: s2) "L"');
    expect(text).toContain(
      "  project pa (archived): draft k1 -> r1 (apply migration #402 to repoint to s1)",
    );
    expect(text).toContain("  project pl: draft k2 -> r2 (apply migration #402 to repoint to s2)");
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
      formatDedupLeftovers({
        retiredCount: 0,
        retiredByDeletedAt: [],
        publishedRetirees: [],
        orphanedChildren: [],
      }),
    ).toBe(
      [
        "0 soft-deleted draft(s) have a live twin.",
        "0 retired draft(s) still have a published issue.",
        "0 live draft(s) name a retired parent.",
      ].join("\n"),
    );
  });

  it("lists each duplicate issue and each orphaned child", () => {
    const text = formatDedupLeftovers({
      retiredCount: 3,
      retiredByDeletedAt: [
        { deletedAt: "2026-09-01T00:00:00.000Z", count: 1 },
        { deletedAt: "2026-10-01T12:00:00.000Z", count: 2 },
      ],
      publishedRetirees: [EXPECTED_PUBLISHED[1], EXPECTED_PUBLISHED[2]],
      orphanedChildren: [
        {
          projectId: "p1",
          draftId: "c_live",
          retiredParentId: "d_e",
          repair: "survivor",
          survivorDraftId: "d_d",
          projectArchived: false,
        },
        {
          projectId: "p1",
          draftId: "d_s2",
          retiredParentId: "d_s1",
          repair: "self",
          survivorDraftId: "d_s2",
          projectArchived: false,
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "3 soft-deleted draft(s) have a live twin, by deletedAt (#369 retired its duplicates at one timestamp; any other is a separate soft-delete):",
      "  2026-09-01T00:00:00.000Z: 1",
      "  2026-10-01T12:00:00.000Z: 2",
      "2 retired draft(s) still have a published issue (close the duplicate if it is unwanted):",
      '  project p1: draft d_e (kept: d_d) "T"',
      "    github #14 https://gh/14 [failed] (publish marked failed; remote issue exists)",
      '  project p1: draft d_p2 (kept: d_p1) "T"',
      "    jira #7 https://gh/7 [updated]",
      "    github #11 https://gh/11 [created]",
      "2 live draft(s) name a retired parent:",
      "  project p1: draft c_live -> d_e (apply migration #402 to repoint to d_d)",
      "  project p1: draft d_s2 -> d_s1 (it is the kept draft; shown as parentless)",
    ]);
  });
});

describe("#396 — formatDedupLeftovers never passes control characters to the terminal", () => {
  const hostile = "evil\u001b[2K\rFAKE LINE\nsecond\u009b31m\u0007\u007f";
  const text = formatDedupLeftovers({
    retiredCount: 1,
    retiredByDeletedAt: [{ deletedAt: `2026\u001b[1m`, count: 1 }],
    publishedRetirees: [
      {
        projectId: `p\u001b]0;x\u0007`,
        retiredDraftId: `d\r`,
        survivorDraftId: `s\n`,
        title: hostile,
        projectArchived: false,
        issues: [
          {
            destination: `gh\u001b[A`,
            issueNumber: 1,
            htmlUrl: `https://x/\r\nINJECTED`,
            batchId: "b",
            status: `created\u001b[2J`,
          },
        ],
      },
    ],
    orphanedChildren: [
      {
        projectId: `p\u009b`,
        draftId: `c\n`,
        retiredParentId: `r\u001b`,
        repair: "survivor",
        survivorDraftId: `s\r`,
        projectArchived: false,
      },
    ],
  });

  it("contains no C0 or C1 control character other than the line separators it adds", () => {
    expect(text.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("cannot add a line: the hostile report has exactly the lines a clean one would", () => {
    const lines = text.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.some((l) => l.startsWith("FAKE LINE") || l.startsWith("second"))).toBe(false);
    expect(lines.some((l) => l.startsWith("INJECTED"))).toBe(false);
    expect(lines[3]).toContain('"evil?[2K?FAKE LINE?second?31m??"');
  });
});
