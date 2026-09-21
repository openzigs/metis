/**
 * Epic #889 (B1 / #891) — RequirementDataMapping model smoke test.
 *
 * Verifies the migration produced a working table by exercising a full
 * create → read → delete cycle against a real database. Gated behind
 * RUN_INTEGRATION_TESTS=1 so the default `vitest run` (which mocks Prisma and
 * has no live DB) stays fast and hermetic. Runs on the dev provider (sqlite)
 * or Postgres — it only needs a reachable DATABASE_URL.
 *
 *   RUN_INTEGRATION_TESTS=1 pnpm --filter @metis/server test \
 *     tests/integration/requirement-data-mapping-model.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";

const ENABLED = process.env.RUN_INTEGRATION_TESTS === "1";
const describeMaybe = ENABLED ? describe : describe.skip;

describeMaybe("Issue #891 — requirement_data_mappings CRUD smoke", () => {
  const suffix = `891-${Date.now()}`;
  let userId = "";
  let projectId = "";
  let analysisId = "";
  let requirementId = "";
  let dbConnectorId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        username: `dm-smoke-${suffix}`,
        displayName: "DM Smoke",
        email: `dm-smoke-${suffix}@example.test`,
      },
    });
    userId = user.id;
    const project = await prisma.project.create({
      data: {
        name: `dm-smoke-${suffix}`,
        slug: `dm-smoke-${suffix}`,
        createdBy: { connect: { id: userId } },
      },
    });
    projectId = project.id;
    const analysis = await prisma.analysis.create({
      data: { projectId, status: "completed", startedById: userId },
    });
    analysisId = analysis.id;
    const requirement = await prisma.requirement.create({
      data: { projectId, analysisId, title: "Login", body: "Users can log in." },
    });
    requirementId = requirement.id;
    const connector = await prisma.databaseConnection.create({
      data: { projectId, label: `db-${suffix}`, driver: "postgres" },
    });
    dbConnectorId = connector.id;
  });

  afterAll(async () => {
    // FK cascades from Project delete clean up the rest.
    if (projectId) {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it("creates, reads and deletes a row", async () => {
    const created = await prisma.requirementDataMapping.create({
      data: {
        requirementId,
        dbConnectorId,
        schemaName: "public",
        tableName: "users",
        columnName: "email",
        confidence: 0.9,
        source: "manual",
        note: "PK email column",
      },
    });
    expect(created.id).toBeTruthy();
    expect(created.confidence).toBe(0.9);

    const read = await prisma.requirementDataMapping.findUnique({ where: { id: created.id } });
    expect(read?.tableName).toBe("users");
    expect(read?.columnName).toBe("email");

    await prisma.requirementDataMapping.delete({ where: { id: created.id } });
    const afterDelete = await prisma.requirementDataMapping.findUnique({
      where: { id: created.id },
    });
    expect(afterDelete).toBeNull();
  });

  it("enforces the unique (requirement, connector, schema, table, column) guard", async () => {
    // NOTE: SQLite/Postgres treat NULLs as distinct in unique indexes, so the
    // DB guard only fires for fully-specified tuples; table-level (null column)
    // duplicate detection lives in the service layer (#892). Use a concrete
    // column here so the index itself is exercised.
    const row = await prisma.requirementDataMapping.create({
      data: {
        requirementId,
        dbConnectorId,
        schemaName: "public",
        tableName: "orders",
        columnName: "id",
      },
    });
    await expect(
      prisma.requirementDataMapping.create({
        data: {
          requirementId,
          dbConnectorId,
          schemaName: "public",
          tableName: "orders",
          columnName: "id",
        },
      }),
    ).rejects.toThrow();
    await prisma.requirementDataMapping.delete({ where: { id: row.id } });
  });
});
