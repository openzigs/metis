/**
 * #759 — `runScanWithPrismaPorts` must hand the scheduler's attempt counter to
 * the orchestrator. `attempt` is optional on `runScan`, so dropping it here
 * typechecks; without it every timeout says "no retries left".
 */
import { describe, expect, it, vi } from "vitest";

const mockRunScan = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./orchestrator.js")>()),
  runScan: mockRunScan,
}));
vi.mock("../prisma.js", () => ({ prisma: {} }));

import { runScanWithPrismaPorts } from "./prisma-adapter.js";

describe("runScanWithPrismaPorts", () => {
  it("passes the scan id, signal and attempt through to the orchestrator", async () => {
    const signal = new AbortController().signal;
    const attempt = { attempts: 2, maxAttempts: 3 };
    await runScanWithPrismaPorts("scan-1", signal, attempt);
    expect(mockRunScan).toHaveBeenCalledExactlyOnceWith(expect.any(Object), {
      scanId: "scan-1",
      signal,
      attempt,
    });
  });
});
