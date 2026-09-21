/**
 * Issue #580 — MCP provider status → PagerDuty sev-1 watcher tests.
 *
 * The watcher subscribes to MCP lifecycle status events and fires a PagerDuty
 * incident on the EDGE into `error`, and resolves it on the edge back to `ready`.
 * Edge-detection (vs level) means a flapping/sustained-down server collapses into
 * a single incident keyed by serverId, not one per health tick.
 *
 * Workspace resolution: project-scoped servers derive the workspace from their
 * project; global/user-scoped servers fall back to the ops workspace.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The default (no-override) hook wiring delegates to alerting-hooks; mock it so we
// can prove the watcher reaches the real hooks without constructing a network
// client or PagerDuty config.
const downSpy = vi.fn(async () => undefined);
const recoveredSpy = vi.fn(async () => undefined);
vi.mock("./alerting-hooks.js", () => ({
  pagerDutyProviderDown: (...args: unknown[]) => downSpy(...args),
  pagerDutyProviderRecovered: (...args: unknown[]) => recoveredSpy(...args),
}));

import { PagerDutyProviderStatusWatcher } from "./provider-status-watcher.js";
import type { MCPStatusEvent } from "../mcp/types.js";

function ev(over: Partial<MCPStatusEvent>): MCPStatusEvent {
  return {
    serverId: "srv-1",
    label: "fs-mcp",
    scope: "project",
    projectId: "p-1",
    status: "ready",
    latencyMs: 1,
    failureCount: 0,
    lastError: null,
    ts: Date.now(),
    ...over,
  };
}

function makeHooks() {
  return {
    down: vi.fn(async () => undefined),
    recovered: vi.fn(async () => undefined),
  };
}

function makeDb(workspaceId: string | null) {
  return {
    project: { findFirst: vi.fn(async () => (workspaceId ? { workspaceId } : null)) },
  };
}

describe("PagerDutyProviderStatusWatcher", () => {
  const origOps = process.env.PAGERDUTY_OPS_WORKSPACE_ID;
  afterEach(() => {
    if (origOps === undefined) delete process.env.PAGERDUTY_OPS_WORKSPACE_ID;
    else process.env.PAGERDUTY_OPS_WORKSPACE_ID = origOps;
  });

  it("fires providerDown on the edge into error (project-scoped → derived workspace)", async () => {
    const hooks = makeHooks();
    const db = makeDb("ws-9");
    const w = new PagerDutyProviderStatusWatcher({ db: db as never, ...hooks });

    await w.onStatus(ev({ status: "error", lastError: "transport_closed" }));

    expect(hooks.down).toHaveBeenCalledTimes(1);
    expect(hooks.down.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws-9",
      serverId: "srv-1",
      label: "fs-mcp",
      lastError: "transport_closed",
    });
  });

  it("does NOT re-fire while it stays in error (edge, not level)", async () => {
    const hooks = makeHooks();
    const w = new PagerDutyProviderStatusWatcher({ db: makeDb("ws-9") as never, ...hooks });
    await w.onStatus(ev({ status: "error", lastError: "e" }));
    await w.onStatus(ev({ status: "error", lastError: "e" }));
    expect(hooks.down).toHaveBeenCalledTimes(1);
  });

  it("fires providerRecovered on the edge error → ready", async () => {
    const hooks = makeHooks();
    const w = new PagerDutyProviderStatusWatcher({ db: makeDb("ws-9") as never, ...hooks });
    await w.onStatus(ev({ status: "error", lastError: "e" }));
    await w.onStatus(ev({ status: "ready" }));
    expect(hooks.recovered).toHaveBeenCalledTimes(1);
    expect(hooks.recovered.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws-9",
      serverId: "srv-1",
    });
  });

  it("does not fire recovered if it was never down", async () => {
    const hooks = makeHooks();
    const w = new PagerDutyProviderStatusWatcher({ db: makeDb("ws-9") as never, ...hooks });
    await w.onStatus(ev({ status: "ready" }));
    expect(hooks.recovered).not.toHaveBeenCalled();
    expect(hooks.down).not.toHaveBeenCalled();
  });

  it("uses the ops workspace for a global-scoped server (no project)", async () => {
    process.env.PAGERDUTY_OPS_WORKSPACE_ID = "ws-ops";
    const hooks = makeHooks();
    const db = makeDb(null);
    const w = new PagerDutyProviderStatusWatcher({ db: db as never, ...hooks });
    await w.onStatus(ev({ status: "error", scope: "global", projectId: null, lastError: "e" }));
    expect(hooks.down).toHaveBeenCalledTimes(1);
    expect(hooks.down.mock.calls[0][0]).toMatchObject({ workspaceId: "ws-ops" });
  });

  it("no-ops for a global server when no ops workspace is configured", async () => {
    delete process.env.PAGERDUTY_OPS_WORKSPACE_ID;
    const hooks = makeHooks();
    const w = new PagerDutyProviderStatusWatcher({ db: makeDb(null) as never, ...hooks });
    await w.onStatus(ev({ status: "error", scope: "global", projectId: null, lastError: "e" }));
    // edge state still tracked, but no workspace → no fire.
    expect(hooks.down).not.toHaveBeenCalled();
  });

  it("ignores intermediate states (starting/idle) without firing", async () => {
    const hooks = makeHooks();
    const w = new PagerDutyProviderStatusWatcher({ db: makeDb("ws-9") as never, ...hooks });
    await w.onStatus(ev({ status: "starting" }));
    await w.onStatus(ev({ status: "idle" }));
    expect(hooks.down).not.toHaveBeenCalled();
    expect(hooks.recovered).not.toHaveBeenCalled();
  });

  it("uses the default alerting-hooks when no hook overrides are supplied", async () => {
    downSpy.mockClear();
    recoveredSpy.mockClear();
    const db = makeDb("ws-9");
    const w = new PagerDutyProviderStatusWatcher({ db: db as never });
    await w.onStatus(ev({ status: "error", lastError: "e" }));
    await w.onStatus(ev({ status: "ready" }));
    expect(downSpy).toHaveBeenCalledTimes(1);
    expect(recoveredSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws if a hook rejects", async () => {
    const hooks = makeHooks();
    hooks.down.mockRejectedValueOnce(new Error("boom"));
    const w = new PagerDutyProviderStatusWatcher({ db: makeDb("ws-9") as never, ...hooks });
    await expect(w.onStatus(ev({ status: "error", lastError: "e" }))).resolves.toBeUndefined();
  });
});
