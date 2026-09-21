/**
 * Issue #853 (Epic #852) — shared contract for `Project.databaseAwareAnalysis`.
 *
 * This issue is schema-only: the Prisma column + its default are proven by
 * the gated Prisma integration test (`server/tests/integration/
 * project-database-aware-analysis.integration.test.ts`). What's tested here
 * is the pure, DB-independent piece — the whitelist every future write path
 * (#857 settings route, #854 resolver) must validate against.
 */
import { describe, expect, it } from "vitest";
import {
  DATABASE_AWARE_ANALYSIS_SETTINGS,
  DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING,
  databaseAwareAnalysisSettingSchema,
  updateDatabaseAwareAnalysisSchema,
} from "./schema-impact.js";

describe("DATABASE_AWARE_ANALYSIS_SETTINGS", () => {
  it("is exactly auto | on | off", () => {
    expect(DATABASE_AWARE_ANALYSIS_SETTINGS).toEqual(["auto", "on", "off"]);
  });

  it("defaults to auto, matching the Prisma column default", () => {
    expect(DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING).toBe("auto");
    expect(DATABASE_AWARE_ANALYSIS_SETTINGS).toContain(DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING);
  });
});

describe("databaseAwareAnalysisSettingSchema", () => {
  it.each(DATABASE_AWARE_ANALYSIS_SETTINGS)("accepts %s", (value) => {
    expect(databaseAwareAnalysisSettingSchema.parse(value)).toBe(value);
  });

  it.each(["ON", "Auto", "always", "", " auto", "true", "1", null, undefined, 42])(
    "rejects invalid value %j (OWASP: whitelist, not blacklist)",
    (value) => {
      expect(() => databaseAwareAnalysisSettingSchema.parse(value)).toThrow();
    },
  );
});

describe("updateDatabaseAwareAnalysisSchema", () => {
  it("parses a valid PATCH payload", () => {
    expect(updateDatabaseAwareAnalysisSchema.parse({ databaseAwareAnalysis: "on" })).toEqual({
      databaseAwareAnalysis: "on",
    });
  });

  it("rejects a payload with an out-of-whitelist value", () => {
    expect(() =>
      updateDatabaseAwareAnalysisSchema.parse({ databaseAwareAnalysis: "enabled" }),
    ).toThrow();
  });

  it("rejects a payload missing the field", () => {
    expect(() => updateDatabaseAwareAnalysisSchema.parse({})).toThrow();
  });
});
