/**
 * Requirement ↔ data mapping service — transaction (TOCTOU) coverage.
 *
 * The router suite (`server/src/routes/data-mappings.test.ts`) exercises the
 * service via injected delegate mocks that have no `$transaction`, covering the
 * fallback path. This suite injects a fake client *with* `$transaction` to
 * verify the dup-check + insert run atomically inside it (Epic #889 / #893
 * TOCTOU hardening).
 */
import { describe, expect, it, vi } from "vitest";
import { create } from "./requirement-data-mapping.js";
import type { RequirementDataMappingDeps } from "./requirement-data-mapping.js";

const ROW = {
  id: "map-1",
  requirementId: "req-1",
  dbConnectorId: "db-1",
  schemaName: null,
  tableName: "users",
  columnName: null,
  confidence: 0.7,
  source: "manual",
  note: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  dbConnector: { label: "Prod DB" },
};

function fakePrisma(overrides?: { existing?: { id: string } | null }) {
  const requirementDataMapping = {
    findFirst: vi.fn().mockResolvedValue(overrides?.existing ?? null),
    create: vi.fn().mockResolvedValue(ROW),
  };
  const txClient = { requirementDataMapping };
  const $transaction = vi.fn(async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient));
  return {
    requirementDataMapping,
    requirement: { findFirst: vi.fn().mockResolvedValue({ id: "req-1" }) },
    databaseConnection: { findFirst: vi.fn().mockResolvedValue({ id: "db-1" }) },
    $transaction,
  };
}

function depsFrom(p: ReturnType<typeof fakePrisma>): RequirementDataMappingDeps {
  return { prisma: p as unknown as RequirementDataMappingDeps["prisma"] };
}

describe("requirement-data-mapping create — transaction hardening", () => {
  it("runs the dup-check + insert inside $transaction when available", async () => {
    const p = fakePrisma();

    const result = await create(
      "proj-1",
      "req-1",
      { dbConnectorId: "db-1", tableName: "users" },
      depsFrom(p),
    );

    expect(result.id).toBe("map-1");
    expect(p.$transaction).toHaveBeenCalledOnce();
    expect(p.requirementDataMapping.findFirst).toHaveBeenCalledOnce();
    expect(p.requirementDataMapping.create).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate detected inside the transaction with a 409", async () => {
    const p = fakePrisma({ existing: { id: "dup" } });

    await expect(
      create("proj-1", "req-1", { dbConnectorId: "db-1", tableName: "users" }, depsFrom(p)),
    ).rejects.toMatchObject({ statusCode: 409, code: "DATA_MAPPING_EXISTS" });
    expect(p.requirementDataMapping.create).not.toHaveBeenCalled();
  });
});
