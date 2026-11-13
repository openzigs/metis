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
let repoConnectionRow: { id: string } | null = null;

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => codeGraphRow) },
    document: {
      findFirst: vi.fn(async ({ where }: { where: { source?: string } }) =>
        where.source === "repo" ? repoSourceRow : null,
      ),
    },
    // #2454 — a live (not soft-deleted) repository connection of the project.
    repoConnection: {
      findMany: vi.fn(async ({ where }: { where: { deletedAt?: null } }) =>
        where.deletedAt === null && repoConnectionRow ? [repoConnectionRow] : [],
      ),
    },
  },
}));

import {
  createCapabilityTracker,
  detectStaticCapability,
  finalizeCapability,
  recordRestrictedLeftOut,
} from "./analysis-capability.js";
import { __resetConfigSingleton } from "../config/config-service.js";

beforeEach(() => {
  codeGraphRow = null;
  repoSourceRow = null;
  repoConnectionRow = null;
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
      // #2454 — no repository, graph or ingested source: a Documents-only project.
      codeConnected: false,
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

  it("#2454 — counts a project as having code once any of repository, graph or source exists", async () => {
    repoConnectionRow = { id: "rc-1" };
    expect((await detectStaticCapability("proj-1")).codeConnected).toBe(true);
    repoConnectionRow = null;
    codeGraphRow = { id: "cg-1" };
    expect((await detectStaticCapability("proj-1")).codeConnected).toBe(true);
    codeGraphRow = null;
    repoSourceRow = { id: "repo-doc-1" };
    expect((await detectStaticCapability("proj-1")).codeConnected).toBe(true);
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

  it("#2454 — a project with no code: no graph or source reasons, and the record says so", () => {
    const tracker = createCapabilityTracker({
      static: { ...baseStatic, fusedCodeRetrievalEnabled: true, codeConnected: false },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    tracker.agentMode = "agentic";
    const cap = finalizeCapability(tracker);
    expect(cap.codeConnected).toBe(false);
    expect(cap.reasons).not.toContain("no-code-graph");
    expect(cap.reasons).not.toContain("source-not-ingested");
  });

  it("#2454 — a project with code writes no codeConnected, so its record is unchanged", () => {
    const tracker = createCapabilityTracker({
      static: { ...baseStatic, fusedCodeRetrievalEnabled: true, codeConnected: true },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    tracker.agentMode = "agentic";
    const cap = finalizeCapability(tracker);
    expect("codeConnected" in cap).toBe(false);
    expect(cap.reasons).toEqual(["no-code-graph", "source-not-ingested"]);
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

  describe("#1388 — an early stop of the code agent is reported once", () => {
    const tracker = () => {
      const t = createCapabilityTracker({
        static: { ...baseStatic, codeGraphPresent: true, repoSourceIngested: true },
        codeAnalysisRequested: true,
        databaseAnalysisRequested: false,
      });
      t.agentMode = "agentic";
      t.codeAgentDegraded = true;
      t.codeRetrievalDegraded = true;
      return t;
    };

    it("drops the coverage reason the early stop already explains", () => {
      const t = tracker();
      t.codeAgentStoppedEarly = true;
      const cap = finalizeCapability(t);
      expect(cap.codeAgentStoppedEarly).toBe(true);
      expect(cap.codeRetrievalDegraded).toBe(true);
      expect(cap.reasons).toContain("code-agent-degraded");
      expect(cap.reasons).not.toContain("code-retrieval-degraded");
    });

    it("keeps it when another pass degraded retrieval for another reason", () => {
      const t = tracker();
      t.codeAgentStoppedEarly = true;
      t.codeRetrievalDegradedOtherwise = true;
      const cap = finalizeCapability(t);
      expect(cap.codeAgentStoppedEarly).toBeUndefined();
      expect(cap.reasons).toEqual(
        expect.arrayContaining(["code-agent-degraded", "code-retrieval-degraded"]),
      );
    });

    it("leaves a run with no early stop unchanged", () => {
      const cap = finalizeCapability(tracker());
      expect("codeAgentStoppedEarly" in cap).toBe(false);
      expect(cap.reasons).toContain("code-retrieval-degraded");
    });
  });
});

// #2437 — what the run's code reads left out because of access restrictions:
// counts and the reason, never a path, and nothing at all when none was.
describe("restrictedLeftOut", () => {
  const capable = () => {
    const tracker = createCapabilityTracker({
      static: {
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
        schemaContextEnabled: true,
      },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    tracker.agentMode = "agentic";
    return tracker;
  };

  it("is absent when nothing was left out", () => {
    const tracker = capable();
    recordRestrictedLeftOut(tracker, { files: 0, symbolIds: [] });
    expect(finalizeCapability(tracker)).not.toHaveProperty("restrictedLeftOut");
  });

  it("counts the files once and each dropped symbol once, over every check", () => {
    const tracker = capable();
    recordRestrictedLeftOut(tracker, { files: 3 });
    recordRestrictedLeftOut(tracker, { files: 3, symbolIds: ["s1", "s2"] });
    recordRestrictedLeftOut(tracker, { files: 2, symbolIds: ["s2", "s3"] });
    const cap = finalizeCapability(tracker);
    expect(cap.restrictedLeftOut).toEqual({ reason: "shared-audience", files: 3, symbols: 3 });
    // It reports a gap; it is not a degraded run.
    expect(cap.reasons).toEqual([]);
  });

  it("persists counts only, never a symbol id", () => {
    const tracker = capable();
    recordRestrictedLeftOut(tracker, { files: 1, symbolIds: ["s-secret"] });
    expect(JSON.stringify(finalizeCapability(tracker))).not.toContain("s-secret");
  });
});
