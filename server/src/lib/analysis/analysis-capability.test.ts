/**
 * Issue #733 — analysis capability detection + tracker unit tests.
 *
 * Covers the READ-ONLY project probe (`detectStaticCapability`), the mutable
 * tracker seed, and the freeze/derive step (`finalizeCapability`) that produces
 * the enumerated degradation reasons persisted on the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let codeGraphRow: { id: string } | null = null;
let repoSourceRow: { id: string } | null = null;

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => codeGraphRow) },
    document: {
      findFirst: vi.fn(async ({ where }: { where: { filename?: { startsWith?: string } } }) =>
        where.filename?.startsWith === "connector:repo:" ? repoSourceRow : null,
      ),
    },
  },
}));

import {
  createCapabilityTracker,
  detectStaticCapability,
  finalizeCapability,
} from "./analysis-capability.js";
import { __resetConfigSingleton } from "../config/config-service.js";

beforeEach(() => {
  codeGraphRow = null;
  repoSourceRow = null;
  __resetConfigSingleton();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetConfigSingleton();
});

describe("detectStaticCapability", () => {
  it("reports a bare project with the grounding flags ON by default (#752)", async () => {
    const cap = await detectStaticCapability("proj-1");
    expect(cap).toEqual({
      codeGraphPresent: false,
      repoSourceIngested: false,
      // #752 — both grounding flags now default ON (config default), so a bare
      // project is degraded only for the graph/source facts, not the flags.
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    });
  });

  it("reflects an operator opt-out (ANALYSIS_*=false) in the probe (tunable)", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "false");
    vi.stubEnv("ANALYSIS_SCHEMA_CONTEXT", "false");
    __resetConfigSingleton();
    const cap = await detectStaticCapability("proj-1");
    expect(cap.fusedCodeRetrievalEnabled).toBe(false);
    expect(cap.schemaContextEnabled).toBe(false);
  });

  it("detects a code graph and ingested repo source", async () => {
    codeGraphRow = { id: "cg-1" };
    repoSourceRow = { id: "repo-doc-1" };
    const cap = await detectStaticCapability("proj-1");
    expect(cap.codeGraphPresent).toBe(true);
    expect(cap.repoSourceIngested).toBe(true);
  });

  it("reads the fused-code and schema-context feature flags from config", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    vi.stubEnv("ANALYSIS_SCHEMA_CONTEXT", "true");
    __resetConfigSingleton();
    const cap = await detectStaticCapability("proj-1");
    expect(cap.fusedCodeRetrievalEnabled).toBe(true);
    expect(cap.schemaContextEnabled).toBe(true);
  });
});

describe("finalizeCapability", () => {
  const baseStatic = {
    codeGraphPresent: false,
    repoSourceIngested: false,
    fusedCodeRetrievalEnabled: false,
    schemaContextEnabled: false,
  };

  it("derives every code reason for a degraded single-shot code run", () => {
    const tracker = createCapabilityTracker({
      static: baseStatic,
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    const cap = finalizeCapability(tracker);
    expect(cap.agentMode).toBe("single-shot");
    expect(cap.reasons).toEqual(
      expect.arrayContaining([
        "no-code-graph",
        "source-not-ingested",
        "agentic-unavailable-no-requirements",
        "fused-code-retrieval-disabled",
      ]),
    );
    // No database agent ⇒ schema reason must NOT fire.
    expect(cap.reasons).not.toContain("schema-context-disabled");
  });

  it("emits no reasons for a fully-capable run", () => {
    const tracker = createCapabilityTracker({
      static: {
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
        schemaContextEnabled: true,
      },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: true,
    });
    tracker.agentMode = "agentic";
    expect(finalizeCapability(tracker).reasons).toEqual([]);
  });

  it("surfaces the quarantine-fallback flag once set on the tracker", () => {
    const tracker = createCapabilityTracker({
      static: {
        ...baseStatic,
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
      },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    tracker.agentMode = "agentic";
    tracker.quarantineFallbackUsed = true;
    const cap = finalizeCapability(tracker);
    expect(cap.quarantineFallbackUsed).toBe(true);
    expect(cap.reasons).toContain("quarantine-fallback-used");
  });

  it("surfaces skipped repos and the budget reason", () => {
    const tracker = createCapabilityTracker({
      static: {
        ...baseStatic,
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
      },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    tracker.agentMode = "agentic";
    tracker.skippedRepos.push({ connectorId: "c3", label: "worker" });
    const cap = finalizeCapability(tracker);
    expect(cap.skippedRepos).toEqual([{ connectorId: "c3", label: "worker" }]);
    expect(cap.reasons).toContain("repos-skipped-budget");
  });

  it("fires schema-context-disabled only when the database agent is requested", () => {
    const withDb = createCapabilityTracker({
      static: {
        ...baseStatic,
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
      },
      codeAnalysisRequested: false,
      databaseAnalysisRequested: true,
    });
    expect(finalizeCapability(withDb).reasons).toContain("schema-context-disabled");
  });
});
