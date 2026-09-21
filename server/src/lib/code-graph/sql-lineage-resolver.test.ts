/**
 * Truth-table unit tests — Issue #894, Epic #882 Phase 3.
 *
 * {@link resolveSqlLineage} is the SINGLE source of truth the ingest wiring
 * (`buildCodeGraphSchemaWiring`, `db-service.ts`) and the settings route
 * (`getProjectSqlLineage`) both call, so every combination of
 * `setting x platformEnabled` is pinned here with an EXACT `reason` assertion.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  resolveSqlLineage,
  resolveProjectSqlLineage,
  type SqlLineageProjectPrismaClient,
} from "./sql-lineage-resolver.js";

describe("resolveSqlLineage", () => {
  describe("setting: off", () => {
    it("disables regardless of platform default (platform=false)", () => {
      expect(resolveSqlLineage({ setting: "off", platformEnabled: false })).toEqual({
        enabled: false,
        reason: "off",
      });
    });

    it("disables regardless of platform default (platform=true)", () => {
      expect(resolveSqlLineage({ setting: "off", platformEnabled: true })).toEqual({
        enabled: false,
        reason: "off",
      });
    });
  });

  describe("setting: on", () => {
    it("enables regardless of platform default (platform=false)", () => {
      expect(resolveSqlLineage({ setting: "on", platformEnabled: false })).toEqual({
        enabled: true,
        reason: "on",
      });
    });

    it("enables regardless of platform default (platform=true)", () => {
      expect(resolveSqlLineage({ setting: "on", platformEnabled: true })).toEqual({
        enabled: true,
        reason: "on",
      });
    });
  });

  describe("setting: auto (default)", () => {
    it("resolves enabled when the platform default is enabled", () => {
      expect(resolveSqlLineage({ setting: "auto", platformEnabled: true })).toEqual({
        enabled: true,
        reason: "auto->platform-enabled",
      });
    });

    it("resolves disabled when the platform default is disabled", () => {
      expect(resolveSqlLineage({ setting: "auto", platformEnabled: false })).toEqual({
        enabled: false,
        reason: "auto->platform-disabled",
      });
    });
  });

  describe("defensive fallback", () => {
    it("degrades an unrecognized setting to auto semantics", () => {
      expect(
        resolveSqlLineage({
          setting: "bogus" as unknown as "auto",
          platformEnabled: true,
        }),
      ).toEqual({ enabled: true, reason: "auto->platform-enabled" });
    });

    it("never throws on a null/undefined input, degrading to auto->platform-disabled", () => {
      expect(resolveSqlLineage(null)).toEqual({
        enabled: false,
        reason: "auto->platform-disabled",
      });
      expect(resolveSqlLineage(undefined)).toEqual({
        enabled: false,
        reason: "auto->platform-disabled",
      });
    });
  });
});

describe("resolveProjectSqlLineage", () => {
  const originalMode = process.env.SQL_LINEAGE_MODE;

  beforeEach(() => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.SQL_LINEAGE_MODE;
    else process.env.SQL_LINEAGE_MODE = originalMode;
  });

  function prismaWith(sqlLineage: string | null): SqlLineageProjectPrismaClient {
    return {
      project: {
        findUnique: vi.fn().mockResolvedValue(sqlLineage === null ? null : { sqlLineage }),
      },
    };
  }

  it("reads the project's raw setting and folds in the platform default", async () => {
    const prisma = prismaWith("on");
    await expect(resolveProjectSqlLineage("proj-1", prisma)).resolves.toEqual({
      setting: "on",
      enabled: true,
      reason: "on",
    });
    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: "proj-1" },
      select: { sqlLineage: true },
    });
  });

  it("defaults to auto when the project row is missing", async () => {
    const prisma = prismaWith(null);
    await expect(resolveProjectSqlLineage("proj-missing", prisma)).resolves.toEqual({
      setting: "auto",
      enabled: true,
      reason: "auto->platform-enabled",
    });
  });

  it("defaults to auto when the stored value is an unrecognized string", () => {
    const prisma = prismaWith("garbage");
    return expect(resolveProjectSqlLineage("proj-2", prisma)).resolves.toEqual({
      setting: "auto",
      enabled: true,
      reason: "auto->platform-enabled",
    });
  });

  it("never throws when the Prisma lookup itself fails — degrades to auto", async () => {
    const prisma: SqlLineageProjectPrismaClient = {
      project: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
    };
    await expect(resolveProjectSqlLineage("proj-3", prisma)).resolves.toEqual({
      setting: "auto",
      enabled: true,
      reason: "auto->platform-enabled",
    });
  });

  it("resolves auto->platform-disabled when SQL_LINEAGE_MODE is not sidecar", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process";
    const prisma = prismaWith("auto");
    await expect(resolveProjectSqlLineage("proj-4", prisma)).resolves.toEqual({
      setting: "auto",
      enabled: false,
      reason: "auto->platform-disabled",
    });
  });

  it("honors an explicit off override even when the platform default is enabled", async () => {
    const prisma = prismaWith("off");
    await expect(resolveProjectSqlLineage("proj-5", prisma)).resolves.toEqual({
      setting: "off",
      enabled: false,
      reason: "off",
    });
  });
});
