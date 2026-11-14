/**
 * #2448 — the run's live room (`analysis:{id}`) is joined by any reader of the
 * project, and a run a person started may cut findings resting on a file only
 * they can read: the capability it broadcasts carries how many findings were
 * cut, never their titles. The snapshot shows the titles to whoever may see
 * them (`redactAnalysisSnapshot`).
 */
import { describe, expect, it, vi } from "vitest";
import type { AnalysisCapability } from "@metis/shared";

vi.mock("../src/lib/analysis/analysis-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analysis/analysis-service.js")>()),
  persistAnalysisCapability: vi.fn(async () => undefined),
}));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");

describe("#2448 — the live capability broadcast", () => {
  it("names no cut finding, and keeps the counts", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const io = {
      to: () => ({ emit: (event: string, payload: unknown) => events.push({ event, payload }) }),
    };
    const orch = new AnalysisOrchestrator({
      provider: { key: "stub", model: "stub", offline: true } as never,
      io: io as never,
    }) as unknown as {
      persistAndEmitCapability(id: string, next: AnalysisCapability): Promise<void>;
    };
    const capability = {
      reasons: [],
      findingsLeftOut: [
        { agentKey: "code", producedCount: 52, keptCount: 50, leftOutTitles: ["Key in vault.ts"] },
      ],
    } as unknown as AnalysisCapability;
    await orch.persistAndEmitCapability("an-1", capability);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("analysis:capability");
    expect(JSON.stringify(events[0]!.payload)).not.toContain("vault");
    expect(
      (events[0]!.payload as { capability: AnalysisCapability }).capability.findingsLeftOut,
    ).toEqual([{ agentKey: "code", producedCount: 52, keptCount: 50, leftOutTitles: [] }]);
  });
});
