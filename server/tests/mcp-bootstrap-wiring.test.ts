/**
 * Epic #272 — bootstrap wiring sanity test.
 *
 * Verifies that `bootstrapMCP` actually instantiates the cold-start reaper
 * AND wires a non-null `coldStartWakeup` hook into the tool bridge, so the
 * subsystems delivered by sub-issues #289/#290/#292 don't sit on the floor
 * exported but never instantiated. (Yes, that already happened once.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/vault/env-manager.js", () => ({
  expandVaultRefs: async (env: Record<string, string>) => env,
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({}),
}));

import { bootstrapMCP } from "../src/lib/mcp/index.js";
import { K8sColdStartReaper } from "../src/lib/mcp/k8s-cold-start-reaper.js";

let teardown: (() => Promise<void>) | null = null;

beforeEach(() => {
  teardown = null;
});

afterEach(async () => {
  if (teardown) await teardown();
  teardown = null;
  vi.clearAllMocks();
});

describe("bootstrapMCP wiring", () => {
  it("instantiates the K8sColdStartReaper and exposes it on the bootstrap result", () => {
    const boot = bootstrapMCP({ io: null, startHealthMonitor: false });
    teardown = boot.shutdown;
    expect(boot.coldStartReaper).toBeInstanceOf(K8sColdStartReaper);
  });

  it("wires a non-null coldStartWakeup hook into the bridge when the K8s provisioner is available", () => {
    const boot = bootstrapMCP({ io: null, startHealthMonitor: false });
    teardown = boot.shutdown;
    const wake = boot.bridge.getColdStartWakeup();
    expect(typeof wake).toBe("function");
  });

  it("starts the cold-start reaper alongside health monitor when not skipped", () => {
    const startSpy = vi.spyOn(K8sColdStartReaper.prototype, "start");
    const boot = bootstrapMCP({ io: null, startHealthMonitor: true });
    teardown = boot.shutdown;
    expect(startSpy).toHaveBeenCalled();
    startSpy.mockRestore();
  });

  it("stops the cold-start reaper on shutdown", async () => {
    const stopSpy = vi.spyOn(K8sColdStartReaper.prototype, "stop");
    const boot = bootstrapMCP({ io: null, startHealthMonitor: false });
    await boot.shutdown();
    teardown = null;
    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockRestore();
  });
});
