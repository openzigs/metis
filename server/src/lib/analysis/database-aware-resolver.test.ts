/**
 * Truth-table unit tests — Issue #854, Epic #852 Phase 2a.
 *
 * {@link resolveDatabaseAwareAnalysis} is the SINGLE source of truth both the
 * run path (#855) and the gap-report path (#856) will call, so every
 * combination of `setting x envDefault x hasSchemaData` is pinned here with
 * an EXACT `reason` assertion (never just truthiness) — a half-tested
 * resolver is exactly the "half-on state" epic #852 exists to kill.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  combineHasSchemaData,
  hasSchemaData,
  isPlatformFlagExplicit,
  readDbAwareEnvDefault,
  resolveDatabaseAwareAnalysis,
  DB_AWARE_PLATFORM_DEFAULT,
  DB_AWARE_PLATFORM_FLAG_KEYS,
  type DbAwareConfigReader,
  type DbAwareEnvDefault,
  type SchemaDataPrismaClient,
} from "./database-aware-resolver.js";
import { __resetConfigSingleton, getConfigService } from "../config/config-service.js";

const MAPPING_KEY = DB_AWARE_PLATFORM_FLAG_KEYS.affectedSchemaMapping;
const IMPACT_KEY = DB_AWARE_PLATFORM_FLAG_KEYS.schemaImpact;

/**
 * Pre-#849 shapes: no `*Explicit` markers at all. These pin the backward
 * compatibility of the interface — a caller that predates #849 (or a test
 * harness that hand-builds the object) must keep resolving exactly as it did,
 * i.e. down the never-configured, default-ON path.
 */
const OFF: DbAwareEnvDefault = { affectedSchemaMapping: false, schemaImpact: false };
const ON_BOTH: DbAwareEnvDefault = { affectedSchemaMapping: true, schemaImpact: true };
const ON_ONE: DbAwareEnvDefault = { affectedSchemaMapping: true, schemaImpact: false };
const ON_OTHER: DbAwareEnvDefault = { affectedSchemaMapping: false, schemaImpact: true };

/** Both flags EXPLICITLY set false by an operator — the #849 kill-switch. */
const EXPLICIT_OFF_BOTH: DbAwareEnvDefault = {
  affectedSchemaMapping: false,
  schemaImpact: false,
  affectedSchemaMappingExplicit: true,
  schemaImpactExplicit: true,
};

/** Only `ANALYSIS_SCHEMA_IMPACT` explicitly set false; the other untouched. */
const EXPLICIT_OFF_IMPACT_ONLY: DbAwareEnvDefault = {
  affectedSchemaMapping: DB_AWARE_PLATFORM_DEFAULT,
  schemaImpact: false,
  affectedSchemaMappingExplicit: false,
  schemaImpactExplicit: true,
};

/**
 * A structural `ConfigService` stand-in: `getBool` honours the caller's
 * default when a key is absent, `describeSource` reports where the value came
 * from — exactly the two methods {@link readDbAwareEnvDefault} consumes.
 */
function fakeConfig(
  flags: Record<string, { value?: boolean; source: "db" | "env" | "unset" | "vault" }>,
): DbAwareConfigReader {
  return {
    getBool: (key, defaultValue = false) => flags[key]?.value ?? defaultValue,
    describeSource: (key) => ({ source: flags[key]?.source ?? "unset" }),
  };
}

describe("resolveDatabaseAwareAnalysis", () => {
  describe("setting: off", () => {
    it("disables regardless of env flags or schema data (data=false, env=off)", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "off", envDefault: OFF, hasSchemaData: false }),
      ).toEqual({ enabled: false, ran: false, reason: "off" });
    });

    it("disables regardless of env flags or schema data (data=true, env=on)", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "off", envDefault: ON_BOTH, hasSchemaData: true }),
      ).toEqual({ enabled: false, ran: false, reason: "off" });
    });

    it("disables even when both env flags are on and schema data is present", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "off", envDefault: ON_ONE, hasSchemaData: true }),
      ).toEqual({ enabled: false, ran: false, reason: "off" });
    });
  });

  describe("setting: on", () => {
    it("enables and marks ran=true when schema data is present, regardless of env flags", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "on", envDefault: OFF, hasSchemaData: true }),
      ).toEqual({ enabled: true, ran: true, reason: "on" });
    });

    it("enables and marks ran=true when schema data is present and env flags are on", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "on", envDefault: ON_BOTH, hasSchemaData: true }),
      ).toEqual({ enabled: true, ran: true, reason: "on" });
    });

    it("enables but does NOT run (skipped-no-schema-data), never a silent off — env flags off", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "on", envDefault: OFF, hasSchemaData: false }),
      ).toEqual({ enabled: true, ran: false, reason: "skipped-no-schema-data" });
    });

    it("enables but does NOT run (skipped-no-schema-data) even when env flags are on", () => {
      // The whole point of #851: a project-level `on` is reachable WITHOUT
      // operator env config, and is never silently defeated by env state.
      expect(
        resolveDatabaseAwareAnalysis({ setting: "on", envDefault: ON_BOTH, hasSchemaData: false }),
      ).toEqual({ enabled: true, ran: false, reason: "skipped-no-schema-data" });
    });
  });

  describe("setting: auto (depends ONLY on schema-data presence — #851 intent #1)", () => {
    // LOAD-BEARING: this is the exact behaviour #851 exists to unlock — an
    // `auto` project must be reachable WITHOUT any operator env config. Prior
    // to this fix, `auto` + both env flags off silently forced
    // `platform-disabled` even with schema data present, re-creating the
    // default-off unreachability #851 was meant to remove.
    it("resolves auto->resolved-on when BOTH env flags are off but schema data is present — env-off must NOT block auto", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "auto", envDefault: OFF, hasSchemaData: true }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("resolves auto->resolved-off-no-data when both env flags are off and there is no schema data", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "auto", envDefault: OFF, hasSchemaData: false }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->resolved-off-no-data" });
    });

    it("resolves auto->resolved-on when both env flags are on and schema data is present", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "auto", envDefault: ON_BOTH, hasSchemaData: true }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("resolves auto->resolved-off-no-data when both env flags are on but there is no schema data — env-on does NOT force a run without data", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: ON_BOTH,
          hasSchemaData: false,
        }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->resolved-off-no-data" });
    });

    it("resolves auto->resolved-on with a single legacy flag on (ANALYSIS_AFFECTED_SCHEMA_MAPPING only) and schema data present — env state is irrelevant either way", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "auto", envDefault: ON_ONE, hasSchemaData: true }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("resolves auto->resolved-on with a single legacy flag on (ANALYSIS_SCHEMA_IMPACT only) and schema data present — env state is irrelevant either way", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: ON_OTHER,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("resolves auto->resolved-off-no-data with a single legacy flag on but no schema data", () => {
      expect(
        resolveDatabaseAwareAnalysis({ setting: "auto", envDefault: ON_ONE, hasSchemaData: false }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->resolved-off-no-data" });
    });
  });

  // ── #849 — the operator kill-switch on the `auto` path ────────────────────
  describe("setting: auto + an EXPLICITLY configured platform flag (#849)", () => {
    it("resolves auto->platform-disabled when BOTH flags are explicitly false, even with schema data present", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: EXPLICIT_OFF_BOTH,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->platform-disabled" });
    });

    it("resolves auto->platform-disabled when only ANALYSIS_SCHEMA_IMPACT is explicitly false and the other key is untouched", () => {
      // The exact operator scenario #849 restores: `ANALYSIS_SCHEMA_IMPACT=0`
      // on a deployment that never touched the other key. Pre-#849 this was
      // silently overridden — the resolver never read `envDefault` at all.
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: EXPLICIT_OFF_IMPACT_ONLY,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->platform-disabled" });
    });

    it("reports platform-disabled (not a data gap) even when there is no schema data — the reason names the actual cause", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: EXPLICIT_OFF_BOTH,
          hasSchemaData: false,
        }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->platform-disabled" });
    });

    it("does NOT disable when a flag is explicitly set TRUE — an explicit opt-in is not a kill-switch", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: {
            affectedSchemaMapping: true,
            schemaImpact: true,
            affectedSchemaMappingExplicit: true,
            schemaImpactExplicit: true,
          },
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("does NOT disable on a mixed explicit opt-in/opt-out — any explicit true wins for the single shared decision", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "auto",
          envDefault: {
            affectedSchemaMapping: true,
            schemaImpact: false,
            affectedSchemaMappingExplicit: true,
            schemaImpactExplicit: true,
          },
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("a per-project explicit `off` still reports `off`, not `auto->platform-disabled`", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "off",
          envDefault: EXPLICIT_OFF_BOTH,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: false, ran: false, reason: "off" });
    });

    it("a per-project explicit `on` OUTRANKS the platform kill-switch (step 1 beats step 2)", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          setting: "on",
          envDefault: EXPLICIT_OFF_BOTH,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: true, ran: true, reason: "on" });
    });
  });

  describe("defensive fallback (OWASP: never throw uncaught into the analysis run)", () => {
    it("falls back to the validated default (auto) semantics for an unexpected setting value", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          // @ts-expect-error — deliberately exercising a corrupted/unrecognized DB value
          setting: "yolo",
          envDefault: ON_BOTH,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("falls back to auto semantics for null setting", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          // @ts-expect-error — deliberately exercising a corrupted/null DB value
          setting: null,
          envDefault: OFF,
          hasSchemaData: true,
        }),
      ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    });

    it("falls back to auto semantics for undefined setting", () => {
      expect(
        resolveDatabaseAwareAnalysis({
          // @ts-expect-error — deliberately exercising a corrupted/undefined DB value
          setting: undefined,
          envDefault: OFF,
          hasSchemaData: false,
        }),
      ).toEqual({ enabled: false, ran: false, reason: "auto->resolved-off-no-data" });
    });

    it("never throws for any garbage setting value", () => {
      expect(() =>
        resolveDatabaseAwareAnalysis({
          // @ts-expect-error — deliberately exercising a corrupted numeric value
          setting: 42,
          envDefault: OFF,
          hasSchemaData: false,
        }),
      ).not.toThrow();
    });

    it("never throws for a null input and yields the auto/no-data default result", () => {
      expect(() => resolveDatabaseAwareAnalysis(null)).not.toThrow();
      expect(resolveDatabaseAwareAnalysis(null)).toEqual({
        enabled: false,
        ran: false,
        reason: "auto->resolved-off-no-data",
      });
    });

    it("never throws for an undefined input and yields the auto/no-data default result", () => {
      expect(() => resolveDatabaseAwareAnalysis(undefined)).not.toThrow();
      expect(resolveDatabaseAwareAnalysis(undefined)).toEqual({
        enabled: false,
        ran: false,
        reason: "auto->resolved-off-no-data",
      });
    });
  });
});

describe("readDbAwareEnvDefault / isPlatformFlagExplicit (#849)", () => {
  afterEach(() => {
    delete process.env[MAPPING_KEY];
    delete process.env[IMPACT_KEY];
    __resetConfigSingleton();
  });

  it("defaults BOTH flags to ON and marks them not-explicit when nothing is configured", () => {
    expect(readDbAwareEnvDefault(fakeConfig({}))).toEqual({
      affectedSchemaMapping: true,
      schemaImpact: true,
      affectedSchemaMappingExplicit: false,
      schemaImpactExplicit: false,
    });
  });

  it("marks a DB-backed tunable (admin UI) as explicit — source 'db' counts, not just 'env'", () => {
    // Both keys are `tier: "tunable"`, so `describeSource` reports "db" when an
    // operator set them through the admin config surface. Accepting only "env"
    // would silently ignore half the ways an operator can disable this.
    const cfg = fakeConfig({ [IMPACT_KEY]: { value: false, source: "db" } });
    expect(readDbAwareEnvDefault(cfg)).toEqual({
      affectedSchemaMapping: true,
      schemaImpact: false,
      affectedSchemaMappingExplicit: false,
      schemaImpactExplicit: true,
    });
  });

  it("marks an env-set flag as explicit", () => {
    const cfg = fakeConfig({ [MAPPING_KEY]: { value: false, source: "env" } });
    expect(readDbAwareEnvDefault(cfg).affectedSchemaMappingExplicit).toBe(true);
    expect(readDbAwareEnvDefault(cfg).schemaImpactExplicit).toBe(false);
  });

  it("treats an unreadable source as not-explicit and never throws (config double without describeSource)", () => {
    const cfg: DbAwareConfigReader = { getBool: (_k, d = false) => d };
    expect(() => readDbAwareEnvDefault(cfg)).not.toThrow();
    expect(readDbAwareEnvDefault(cfg)).toEqual({
      affectedSchemaMapping: true,
      schemaImpact: true,
      affectedSchemaMappingExplicit: false,
      schemaImpactExplicit: false,
    });
  });

  it("swallows a describeSource throw (unknown-key error) and degrades to not-explicit", () => {
    const cfg: DbAwareConfigReader = {
      getBool: (_k, d = false) => d,
      describeSource: () => {
        throw new Error("unknown config key");
      },
    };
    expect(isPlatformFlagExplicit(cfg, IMPACT_KEY)).toBe(false);
  });

  it("REAL ConfigService: an operator-set env var resolves auto->platform-disabled end to end", () => {
    process.env[IMPACT_KEY] = "0";
    __resetConfigSingleton();

    const envDefault = readDbAwareEnvDefault(getConfigService());
    expect(envDefault.schemaImpact).toBe(false);
    expect(envDefault.schemaImpactExplicit).toBe(true);
    // The untouched key still carries the new default and is NOT explicit.
    expect(envDefault.affectedSchemaMapping).toBe(true);
    expect(envDefault.affectedSchemaMappingExplicit).toBe(false);

    expect(
      resolveDatabaseAwareAnalysis({ setting: "auto", envDefault, hasSchemaData: true }),
    ).toEqual({ enabled: false, ran: false, reason: "auto->platform-disabled" });
  });

  it("REAL ConfigService: with nothing configured, an auto project WITH schema data resolves ON (#849's flip)", () => {
    __resetConfigSingleton();

    const envDefault = readDbAwareEnvDefault(getConfigService());
    expect(envDefault).toEqual({
      affectedSchemaMapping: true,
      schemaImpact: true,
      affectedSchemaMappingExplicit: false,
      schemaImpactExplicit: false,
    });

    expect(
      resolveDatabaseAwareAnalysis({ setting: "auto", envDefault, hasSchemaData: true }),
    ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
    // ...and still OFF with no schema data — the flip does not manufacture data.
    expect(
      resolveDatabaseAwareAnalysis({ setting: "auto", envDefault, hasSchemaData: false }),
    ).toEqual({ enabled: false, ran: false, reason: "auto->resolved-off-no-data" });
  });

  it("REAL ConfigService: an operator-set env TRUE is an opt-in, not a kill-switch", () => {
    process.env[IMPACT_KEY] = "1";
    __resetConfigSingleton();

    const envDefault = readDbAwareEnvDefault(getConfigService());
    expect(envDefault.schemaImpactExplicit).toBe(true);
    expect(
      resolveDatabaseAwareAnalysis({ setting: "auto", envDefault, hasSchemaData: true }),
    ).toEqual({ enabled: true, ran: true, reason: "auto->resolved-on" });
  });
});

describe("combineHasSchemaData", () => {
  it("is false when neither a DB connection nor a non-empty schema graph exist", () => {
    expect(combineHasSchemaData(false, false)).toBe(false);
  });

  it("is true when only a DB connection exists", () => {
    expect(combineHasSchemaData(true, false)).toBe(true);
  });

  it("is true when only a non-empty schema graph exists", () => {
    expect(combineHasSchemaData(false, true)).toBe(true);
  });

  it("is true when both exist", () => {
    expect(combineHasSchemaData(true, true)).toBe(true);
  });
});

describe("hasSchemaData", () => {
  function fakePrisma(counts: {
    dbConnections?: number;
    symbols?: number;
    edges?: number;
  }): SchemaDataPrismaClient {
    return {
      databaseConnection: { count: vi.fn().mockResolvedValue(counts.dbConnections ?? 0) },
      codeSymbol: { count: vi.fn().mockResolvedValue(counts.symbols ?? 0) },
      codeEdge: { count: vi.fn().mockResolvedValue(counts.edges ?? 0) },
    };
  }

  it("is false when there is no DB connection, no schema symbols, and no schema edges", async () => {
    const prisma = fakePrisma({});
    await expect(hasSchemaData(prisma, "proj-1")).resolves.toBe(false);
  });

  it("is true when only a DatabaseConnection row exists", async () => {
    const prisma = fakePrisma({ dbConnections: 1 });
    await expect(hasSchemaData(prisma, "proj-1")).resolves.toBe(true);
  });

  it("is true when only table/column CodeSymbol rows exist", async () => {
    const prisma = fakePrisma({ symbols: 3 });
    await expect(hasSchemaData(prisma, "proj-1")).resolves.toBe(true);
  });

  it("is true when only reads/writes/persists-to CodeEdge rows exist", async () => {
    const prisma = fakePrisma({ edges: 2 });
    await expect(hasSchemaData(prisma, "proj-1")).resolves.toBe(true);
  });

  it("is true when everything is present", async () => {
    const prisma = fakePrisma({ dbConnections: 1, symbols: 3, edges: 2 });
    await expect(hasSchemaData(prisma, "proj-1")).resolves.toBe(true);
  });

  it("queries read-only counts scoped to the given projectId, never mutates", async () => {
    const prisma = fakePrisma({});
    await hasSchemaData(prisma, "proj-42");

    expect(prisma.databaseConnection.count).toHaveBeenCalledWith({
      where: { projectId: "proj-42", deletedAt: null, status: "connected" },
    });
    expect(prisma.codeSymbol.count).toHaveBeenCalledWith({
      where: { projectId: "proj-42", kind: { in: ["table", "column"] } },
    });
    expect(prisma.codeEdge.count).toHaveBeenCalledWith({
      where: { projectId: "proj-42", kind: { in: ["reads", "writes", "persists-to"] } },
    });
  });
});
