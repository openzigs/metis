import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { computeRequirementEscalations, readEscalationPolicy } from "./escalation-context.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AffectedCodeDeps } from "./affected-code-context.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";

/** A mapper that maps requirements whose text contains `needle` to N symbols. */
function mapperFor(needle: string, symbolCount: number): AffectedCodeDeps["mapRequirement"] {
  return async (req) => {
    if (!req.body.includes(needle)) return [];
    return Array.from({ length: symbolCount }, (_, i) => ({
      codeSymbolId: `sym-${i}`,
      filePath: `src/file${i}.ts`,
      qualifiedName: `Mod.fn${i}`,
      startLine: i,
      endLine: i + 1,
      confidence: 0.9,
    }));
  };
}

/** An empty graph ⇒ no blast radius; impact size == direct mapper hits only. */
const emptyGraph: AffectedCodeDeps["dataSourceFor"] = () =>
  ({
    getSymbol: async () => null,
    getEdgesFrom: async () => [],
    getEdgesTo: async () => [],
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async () => [],
  }) as unknown as CodeGraphDataSource;

const ENV_KEYS = [
  "ANALYSIS_ESCALATION_POLICY",
  "ANALYSIS_ESCALATION_SCORE_THRESHOLD",
  "ANALYSIS_ESCALATION_MAX_REQUIREMENTS",
  "ANALYSIS_ESCALATION_DEEP_MAX_TURNS",
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetConfigSingleton();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetConfigSingleton();
});

describe("readEscalationPolicy", () => {
  it("is disabled by default with the documented defaults", () => {
    const { enabled, config } = readEscalationPolicy();
    expect(enabled).toBe(false);
    expect(config.threshold).toBe(0.5);
    expect(config.maxEscalations).toBe(3);
    expect(config.standardMaxTurns).toBe(10);
    expect(config.deepMaxTurns).toBe(16);
  });

  it("reads overrides from config", () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    process.env.ANALYSIS_ESCALATION_SCORE_THRESHOLD = "0.7";
    process.env.ANALYSIS_ESCALATION_MAX_REQUIREMENTS = "1";
    process.env.ANALYSIS_ESCALATION_DEEP_MAX_TURNS = "20";
    __resetConfigSingleton();
    const { enabled, config } = readEscalationPolicy();
    expect(enabled).toBe(true);
    expect(config.threshold).toBe(0.7);
    expect(config.maxEscalations).toBe(1);
    expect(config.deepMaxTurns).toBe(20);
  });
});

describe("computeRequirementEscalations", () => {
  const deps = (): AffectedCodeDeps => ({
    mapRequirement: mapperFor("charge", 8),
    dataSourceFor: emptyGraph,
  });

  it("returns null (no-op) when the policy is disabled", async () => {
    const out = await computeRequirementEscalations({
      projectId: "p",
      requirements: [{ id: "R1", text: "Users can charge invoices" }],
      deps: deps(),
    });
    expect(out).toBeNull();
  });

  it("returns null when there are no requirements", async () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    __resetConfigSingleton();
    const out = await computeRequirementEscalations({
      projectId: "p",
      requirements: [],
      deps: deps(),
    });
    expect(out).toBeNull();
  });

  it("scores impact from the blast-radius size and routes high scorers to deep", async () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    __resetConfigSingleton();
    const out = await computeRequirementEscalations({
      projectId: "p",
      requirements: [
        // Maps to 8 symbols ⇒ impact 1.0 ⇒ score 0.5 ⇒ deep.
        { id: "R1", text: "Users can charge invoices" },
        // No mapper hit + specific text ⇒ score ~0 ⇒ standard.
        { id: "R2", text: "The footer shall display the current build version string" },
      ],
      deps: deps(),
    });
    expect(out).not.toBeNull();
    const byId = Object.fromEntries(out!.escalation.requirements.map((r) => [r.requirementId, r]));
    expect(byId.R1.depth).toBe("deep");
    expect(byId.R1.blastRadiusSize).toBe(8);
    expect(byId.R1.impactScore).toBe(1);
    expect(byId.R2.depth).toBe("standard");
    expect(byId.R2.blastRadiusSize).toBe(0);
    expect(out!.escalation.enabled).toBe(true);
    expect(out!.escalation.threshold).toBe(0.5);
  });

  // A minimal prisma double so the DEFAULT mapper / data-source closures (used
  // when the caller injects only `prisma`) run without a real database.
  const mockPrisma = {
    codeSymbol: { findMany: async () => [], findFirst: async () => null },
    codeEdge: { findMany: async () => [] },
  } as unknown as NonNullable<AffectedCodeDeps["prisma"]>;

  it("uses the default BM25 mapper against an injected prisma (no matches ⇒ impact 0)", async () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    __resetConfigSingleton();
    const out = await computeRequirementEscalations({
      projectId: "p",
      requirements: [{ id: "R1", text: "Users can charge invoices" }],
      // Only `prisma` provided ⇒ the default mapRequirement closure runs.
      deps: { prisma: mockPrisma, dataSourceFor: emptyGraph },
    });
    expect(out).not.toBeNull();
    expect(out!.escalation.requirements[0].blastRadiusSize).toBe(0);
  });

  it("uses the default Prisma-backed data source when only the mapper is injected", async () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    __resetConfigSingleton();
    const out = await computeRequirementEscalations({
      projectId: "p",
      requirements: [{ id: "R1", text: "Users can charge invoices" }],
      // No dataSourceFor ⇒ the default PrismaCodeGraphDataSource closure runs;
      // the empty mock graph yields no blast radius, so size == direct hits (2).
      deps: { prisma: mockPrisma, mapRequirement: mapperFor("charge", 2) },
    });
    expect(out).not.toBeNull();
    expect(out!.escalation.requirements[0].blastRadiusSize).toBe(2);
  });

  it("degrades a requirement to impact 0 when the mapper throws (never throws)", async () => {
    process.env.ANALYSIS_ESCALATION_POLICY = "true";
    __resetConfigSingleton();
    const throwingDeps: AffectedCodeDeps = {
      mapRequirement: async () => {
        throw new Error("graph unavailable");
      },
      dataSourceFor: emptyGraph,
    };
    const out = await computeRequirementEscalations({
      projectId: "p",
      requirements: [{ id: "R1", text: "The footer shall display the build version" }],
      deps: throwingDeps,
    });
    expect(out).not.toBeNull();
    expect(out!.escalation.requirements[0].blastRadiusSize).toBe(0);
    expect(out!.escalation.requirements[0].depth).toBe("standard");
  });
});
