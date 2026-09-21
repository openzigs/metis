/**
 * Issue #853 (Epic #852) — `Project.databaseAwareAnalysis` Prisma smoke test.
 *
 * Verifies the migration produced a working column by exercising a real
 * create → read → update cycle against a live database (sqlite dev.db or
 * Postgres — whatever `DATABASE_URL` points at). Gated behind
 * `RUN_INTEGRATION_TESTS=1` so the default `vitest run` (which mocks Prisma
 * and has no live DB) stays fast and hermetic, matching
 * `requirement-data-mapping-model.integration.test.ts`.
 *
 *   RUN_INTEGRATION_TESTS=1 pnpm --filter @metis/server test \
 *     tests/integration/project-database-aware-analysis.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";

const ENABLED = process.env.RUN_INTEGRATION_TESTS === "1";
const describeMaybe = ENABLED ? describe : describe.skip;

describeMaybe("Issue #853 — projects.databaseAwareAnalysis CRUD smoke", () => {
  const suffix = `853-${Date.now()}`;
  let userId = "";
  const projectIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        username: `daa-smoke-${suffix}`,
        displayName: "DAA Smoke",
        email: `daa-smoke-${suffix}@example.test`,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    for (const id of projectIds) {
      await prisma.project.delete({ where: { id } }).catch(() => undefined);
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it("defaults a newly created project to 'auto'", async () => {
    const project = await prisma.project.create({
      data: { name: `daa-default-${suffix}`, slug: `daa-default-${suffix}`, createdById: userId },
    });
    projectIds.push(project.id);
    expect(project.databaseAwareAnalysis).toBe("auto");
  });

  it("round-trips explicit 'on' and 'off' values through create/update/read", async () => {
    const project = await prisma.project.create({
      data: {
        name: `daa-explicit-${suffix}`,
        slug: `daa-explicit-${suffix}`,
        createdById: userId,
        databaseAwareAnalysis: "on",
      },
    });
    projectIds.push(project.id);
    expect(project.databaseAwareAnalysis).toBe("on");

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { databaseAwareAnalysis: "off" },
    });
    expect(updated.databaseAwareAnalysis).toBe("off");

    const read = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(read.databaseAwareAnalysis).toBe("off");
  });
});
