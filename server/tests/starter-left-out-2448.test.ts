/**
 * #2448 — a code pass of a run a person started reads with that person's
 * access, so what they cannot see is not "left out because results are shared
 * with the whole project" (#2437's `restrictedLeftOut`): inside such a pass the
 * code reads report nothing to the run's capability. Outside one they still do.
 */
import { describe, expect, it, vi } from "vitest";

const resolveSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/rag/acl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/acl.js")>()),
  resolveAclActor: resolveSpy,
}));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker } = await import("../src/lib/analysis/analysis-capability.js");
const { withPassReads } = await import("../src/lib/analysis/pass-reads.js");

type Counter = ((left: { files?: number; symbolIds?: string[] }) => void) | undefined;

describe("#2448 — the shared-audience left-out count on a starter pass", () => {
  it("is not reported inside a pass, and still is outside one", async () => {
    resolveSpy.mockResolvedValue({ userId: "bob", role: "analyst" });
    const orch = new AnalysisOrchestrator({
      provider: { key: "stub", model: "stub", offline: true } as never,
    }) as unknown as {
      capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
      codeLeftOutCounter(id: string): Counter;
    };
    const tracker = createCapabilityTracker({
      static: { codeGraphPresent: true, repoSourceIngested: true } as never,
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    orch.capabilities.set("an-1", tracker);
    const db = {
      analysis: { findUnique: vi.fn(async () => ({ projectId: "p1", sourceAccess: "starter" })) },
      document: { findMany: vi.fn(async () => []) },
      agentResult: { findMany: vi.fn(async () => []) },
    };

    const inside = await withPassReads(
      { analysisId: "an-1", actorId: "bob", agentKey: "code" },
      async () => orch.codeLeftOutCounter("an-1"),
      db as never,
    );
    expect(inside).toBeUndefined();

    // Positive control: outside a pass the same run's code reads are counted.
    const outside = orch.codeLeftOutCounter("an-1");
    expect(outside).toBeTypeOf("function");
    outside!({ symbolIds: ["sym-vault"] });
    expect([...(tracker.restrictedSymbolIds ?? [])]).toEqual(["sym-vault"]);
  });
});
