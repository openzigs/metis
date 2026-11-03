/**
 * #1703 — re-detecting an unchanged product edge writes nothing, on a REAL Postgres.
 *
 * `syncDetectedProductEdges` skips the write for an edge found again exactly as
 * stored (#1643), comparing `confidence` (a Float) to the stored value with
 * `===`. That holds only if Postgres hands back the very double it was given.
 * The SQLite suites prove the rule there; this proves it on the
 * `postgres-adapter` job's database (schema pushed from
 * `server/prisma/postgres/schema.prisma`), with confidences that have no exact
 * decimal form, for a detected edge and an overridden one.
 *
 * Its rows use ids unique to this run and are removed afterwards, since the
 * job's suites share the database. Gated like the other
 * `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DetectedEdge } from "../src/lib/products/relationship-detector.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "postgresql" as const,
  };
});

describe.runIf(enabled)("#1703 unchanged product edges are not rewritten on real Postgres", () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const USER = `u-1703-${suffix}`;
  const PROJECT = `p-1703-${suffix}`;
  const PRODUCT = `prod-1703-${suffix}`;
  const REPOS = [`rc-a-1703-${suffix}`, `rc-b-1703-${suffix}`, `rc-c-1703-${suffix}`];
  let db: PrismaClient;
  let sync: typeof import("../src/lib/products/edge-detection.js").syncDetectedProductEdges;

  // Doubles with no exact decimal form, and one at full precision.
  const edges = (): DetectedEdge[] => [
    {
      sourceRepoId: REPOS[0],
      targetRepoId: REPOS[1],
      edgeType: "calls",
      confidence: 0.1 + 0.2,
      evidence: [{ filePath: "openapi.yaml", pattern: "openapi_ref", matchType: "spec" }],
      sourceFile: "src/client.ts",
      targetFile: "openapi.yaml",
      integrationKind: "api",
      strength: "contract",
      direction: "consumes",
    },
    {
      sourceRepoId: REPOS[1],
      targetRepoId: REPOS[2],
      edgeType: "imports",
      confidence: 2 / 3,
      evidence: [{ filePath: "types/order.ts", pattern: "shared_type", matchType: "type" }],
      integrationKind: "shared-library",
      strength: "model",
      direction: "depends-on",
    },
    {
      sourceRepoId: REPOS[0],
      targetRepoId: REPOS[2],
      edgeType: "calls",
      confidence: 0.7234567890123456,
      evidence: [],
      integrationKind: "api",
      strength: "contract",
      direction: "consumes",
    },
  ];

  const stored = () =>
    db.productEdge.findMany({
      where: { productId: PRODUCT },
      orderBy: { id: "asc" },
      select: { id: true, confidence: true, origin: true, strength: true, updatedAt: true },
    });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    state.db = db;
    ({ syncDetectedProductEdges: sync } = await import("../src/lib/products/edge-detection.js"));
    await db.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
    });
    await db.project.create({
      data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
    });
    for (const id of REPOS) {
      await db.repoConnection.create({ data: { id, projectId: PROJECT, label: id } });
    }
    await db.product.create({
      data: { id: PRODUCT, name: PRODUCT, slug: PRODUCT, createdById: USER },
    });
    for (const id of REPOS) {
      await db.productRepo.create({ data: { productId: PRODUCT, repoConnectionId: id } });
    }
  });

  afterAll(async () => {
    if (db) {
      // Edges and product repos cascade with the product and the repos.
      await db.product.deleteMany({ where: { id: PRODUCT } });
      await db.project.deleteMany({ where: { id: PROJECT } });
      await db.user.deleteMany({ where: { id: USER } });
      await db.$disconnect();
    }
  });

  it("stores each confidence exactly and leaves unchanged edges unwritten on a re-run", async () => {
    expect(await sync(PRODUCT, REPOS, edges())).toMatchObject({ created: 3, updated: 0 });
    const first = await stored();
    expect(first.map((e) => e.confidence).sort()).toEqual(
      edges()
        .map((e) => e.confidence)
        .sort(),
    );

    // An overridden edge is compared on detection's facts alone.
    await db.productEdge.update({
      where: { id: first[0].id },
      data: { origin: "overridden", strength: "intrusive" },
    });
    const before = await stored();

    expect(await sync(PRODUCT, REPOS, edges())).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      keptDeclared: 0,
    });
    // Not written at all: `updatedAt` is where Prisma would have recorded one.
    expect(await stored()).toEqual(before);
  });

  it("does write an edge whose confidence moved by the smallest step", async () => {
    const moved = edges();
    moved[1] = { ...moved[1], confidence: moved[1].confidence + Number.EPSILON };
    expect(await sync(PRODUCT, REPOS, moved)).toMatchObject({ created: 0, updated: 1 });
  });
});
