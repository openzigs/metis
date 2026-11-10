/**
 * #2209 — the discussion requirement picker's search on a REAL Postgres.
 *
 * `searchProjectRequirements` matches titles in a tagged `$queryRaw`, folding
 * both sides with `LOWER()` (Prisma's `contains` is case-sensitive on Postgres,
 * and `mode: "insensitive"` exists only in the Postgres-generated client). The
 * SQLite suite (`discussion-requirement-picker.sqlite.test.ts`) proves it on
 * SQLite and is skipped here, and SQLite's `LIKE` ignores ASCII case on its
 * own, so only Postgres can show the `LOWER` is load-bearing. This runs the
 * same query against Postgres: the quoted camel-case columns, the join, the
 * `ESCAPE '!'` clause and the bound `LIMIT` all have to hold on both.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { searchProjectRequirements } from "../src/lib/discussions/requirement-search.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-2209pg-${SUFFIX}`;
const PROJECT = `p-2209pg-${SUFFIX}`;
const OTHER = `p-2209pg-other-${SUFFIX}`;
const LIVE = `a-2209pg-live-${SUFFIX}`;
const GONE = `a-2209pg-gone-${SUFFIX}`;
const ELSEWHERE = `a-2209pg-other-${SUFFIX}`;
const id = (name: string) => `r-2209pg-${name}-${SUFFIX}`;

describe.runIf(enabled)("#2209 requirement picker search on real Postgres (integration)", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
    });
    for (const p of [PROJECT, OTHER]) {
      await prisma.project.create({ data: { id: p, name: p, slug: p, createdById: USER } });
    }
    await prisma.analysis.create({ data: { id: LIVE, projectId: PROJECT } });
    await prisma.analysis.create({
      data: { id: GONE, projectId: PROJECT, deletedAt: new Date() },
    });
    await prisma.analysis.create({ data: { id: ELSEWHERE, projectId: OTHER } });

    const base = Date.UTC(2026, 0, 1);
    const rows: Array<[string, string, string, number, Date | null]> = [
      [id("mixed"), LIVE, "Refresh Feeds On A Schedule", 1, null],
      [id("pct"), LIVE, "Hit 100% of feeds", 2, null],
      [id("under"), LIVE, "Store read_at per entry", 3, null],
      [id("deleted"), LIVE, "Refresh feeds, removed", 4, new Date()],
      [id("gone-run"), GONE, "Refresh feeds in a deleted run", 5, null],
    ];
    for (const [rid, analysisId, title, at, deletedAt] of rows) {
      await prisma.requirement.create({
        data: {
          id: rid,
          projectId: PROJECT,
          analysisId,
          title,
          body: "b",
          createdAt: new Date(base + at * 1000),
          deletedAt,
        },
      });
    }
    await prisma.requirement.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        id: id(`filler-${String(i).padStart(2, "0")}`),
        projectId: PROJECT,
        analysisId: LIVE,
        title: `Filler requirement ${i}`,
        body: "b",
        createdAt: new Date(base + (100 + i) * 1000),
      })),
    });
    await prisma.requirement.create({
      data: {
        id: id("other-project"),
        projectId: OTHER,
        analysisId: ELSEWHERE,
        title: "Refresh feeds in another project",
        body: "b",
      },
    });
  });

  afterAll(async () => {
    await prisma.requirement.deleteMany({ where: { projectId: { in: [PROJECT, OTHER] } } });
    await prisma.analysis.deleteMany({ where: { projectId: { in: [PROJECT, OTHER] } } });
    await prisma.project.deleteMany({ where: { id: { in: [PROJECT, OTHER] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
  });

  const ids = async (term: string) =>
    (await searchProjectRequirements(PROJECT, term)).map((r) => r.id);

  it("matches a title whatever the case of either side", async () => {
    expect(await ids("refresh feeds")).toEqual([id("mixed")]);
    expect(await ids("REFRESH FEEDS ON")).toEqual([id("mixed")]);
  });

  it("matches the term's % and _ literally", async () => {
    expect(await ids("%")).toEqual([id("pct")]);
    expect(await ids("d_a")).toEqual([id("under")]);
  });

  it("answers at most 20 matches, newest first, as full rows", async () => {
    const rows = await searchProjectRequirements(PROJECT, "filler");
    expect(rows.map((r) => r.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => id(`filler-${String(24 - i).padStart(2, "0")}`)),
    );
    expect(rows[0]).toEqual({
      id: id("filler-24"),
      title: "Filler requirement 24",
      analysisId: LIVE,
      createdAt: new Date(Date.UTC(2026, 0, 1) + 124 * 1000),
    });
  });

  it("offers nothing soft-deleted, in a soft-deleted run, or in another project", async () => {
    expect(await ids("removed")).toEqual([]);
    expect(await ids("deleted run")).toEqual([]);
    expect(await ids("another project")).toEqual([]);
  });
});
