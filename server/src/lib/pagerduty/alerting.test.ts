/**
 * Issue #580 — sev-1 alerting orchestration tests.
 *
 * `PagerDutyAlerter` is the thin, best-effort layer the three sev-1 sources call.
 * It resolves the owning workspace's routing key, builds a stable dedup key + a
 * sanitized incident payload, and triggers/resolves a PagerDuty incident. A
 * missing config or a PagerDuty API failure must NEVER throw to the caller (the
 * originating publish/rotation/health op must be unaffected).
 */
import { describe, expect, it, vi } from "vitest";

import { PagerDutyAlerter } from "./alerting.js";

function makeClient() {
  return {
    trigger: vi.fn(async () => ({ dedupKey: "k", status: "success", message: null })),
    resolve: vi.fn(async () => ({ dedupKey: "k", status: "success", message: null })),
  };
}

function makeConfigStore(routingKey: string | null) {
  return {
    resolveRoutingKey: vi.fn(async () => routingKey),
  };
}

describe("PagerDutyAlerter", () => {
  it("publish rollback → triggers a critical incident with a stable dedup key + context", async () => {
    const client = makeClient();
    const configStore = makeConfigStore("RK");
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: configStore as never,
    });

    await alerter.publishRollback({
      workspaceId: "ws-1",
      projectId: "p-1",
      projectName: "Acme",
      batchId: "batch-9",
      reason: "auto-rollback: 6/10 drafts failed",
      repo: "octo/acme",
    });

    expect(configStore.resolveRoutingKey).toHaveBeenCalledWith("ws-1", "default");
    expect(client.trigger).toHaveBeenCalledTimes(1);
    const arg = client.trigger.mock.calls[0][0];
    expect(arg.routingKey).toBe("RK");
    expect(arg.severity).toBe("critical");
    expect(arg.dedupKey).toBe("metis:publish-rollback:batch-9");
    expect(arg.summary).toContain("Acme");
    expect(arg.customDetails).toMatchObject({
      workspaceId: "ws-1",
      projectId: "p-1",
      batchId: "batch-9",
      repo: "octo/acme",
    });
    // Publish rollback is one-shot — never resolved automatically.
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("vault rotation failure → triggers a critical incident keyed by secret id", async () => {
    const client = makeClient();
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: makeConfigStore("RK") as never,
    });

    await alerter.vaultRotationFailure({
      workspaceId: "ws-1",
      secretId: "sec-7",
      label: "teams-bot-password",
      reason: "decrypt failed: auth tag mismatch",
    });

    const arg = client.trigger.mock.calls[0][0];
    expect(arg.dedupKey).toBe("metis:vault-rotation-failure:sec-7");
    expect(arg.severity).toBe("critical");
    expect(arg.customDetails).toMatchObject({ secretId: "sec-7", label: "teams-bot-password" });
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("provider down → triggers a critical incident keyed by server id", async () => {
    const client = makeClient();
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: makeConfigStore("RK") as never,
    });

    await alerter.providerDown({
      workspaceId: "ws-1",
      serverId: "srv-3",
      label: "filesystem-mcp",
      lastError: "transport_closed:exited",
    });

    const arg = client.trigger.mock.calls[0][0];
    expect(arg.dedupKey).toBe("metis:provider-down:srv-3");
    expect(arg.severity).toBe("critical");
    expect(arg.customDetails).toMatchObject({ serverId: "srv-3", label: "filesystem-mcp" });
  });

  it("provider recovered → resolves the SAME dedup key used by providerDown", async () => {
    const client = makeClient();
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: makeConfigStore("RK") as never,
    });

    await alerter.providerRecovered({ workspaceId: "ws-1", serverId: "srv-3" });

    expect(client.resolve).toHaveBeenCalledTimes(1);
    const arg = client.resolve.mock.calls[0][0];
    expect(arg.routingKey).toBe("RK");
    expect(arg.dedupKey).toBe("metis:provider-down:srv-3");
    expect(client.trigger).not.toHaveBeenCalled();
  });

  it("is a no-op when the workspace has no configured routing key", async () => {
    const client = makeClient();
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: makeConfigStore(null) as never,
    });
    await alerter.publishRollback({
      workspaceId: "ws-1",
      projectId: "p",
      projectName: "n",
      batchId: "b",
      reason: "r",
      repo: null,
    });
    expect(client.trigger).not.toHaveBeenCalled();
  });

  it("is a no-op when workspaceId is missing", async () => {
    const client = makeClient();
    const configStore = makeConfigStore("RK");
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: configStore as never,
    });
    await alerter.publishRollback({
      workspaceId: "",
      projectId: "p",
      projectName: "n",
      batchId: "b",
      reason: "r",
      repo: null,
    });
    expect(configStore.resolveRoutingKey).not.toHaveBeenCalled();
    expect(client.trigger).not.toHaveBeenCalled();
  });

  it("swallows a PagerDuty API failure — never throws to the caller", async () => {
    const client = makeClient();
    client.trigger.mockRejectedValueOnce(new Error("PagerDuty 429"));
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: makeConfigStore("RK") as never,
    });
    // Must resolve (not reject) despite the API failure.
    await expect(
      alerter.providerDown({ workspaceId: "ws-1", serverId: "s", label: "l", lastError: "e" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a config-resolution failure — never throws to the caller", async () => {
    const client = makeClient();
    const configStore = {
      resolveRoutingKey: vi.fn(async () => {
        throw new Error("vault read failed");
      }),
    };
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: configStore as never,
    });
    await expect(
      alerter.vaultRotationFailure({ workspaceId: "ws-1", secretId: "s", label: "l", reason: "r" }),
    ).resolves.toBeUndefined();
    expect(client.trigger).not.toHaveBeenCalled();
  });

  it("routes to a non-default service key when provided", async () => {
    const client = makeClient();
    const configStore = makeConfigStore("RK-INFRA");
    const alerter = new PagerDutyAlerter({
      client: client as never,
      configStore: configStore as never,
    });
    await alerter.providerDown({
      workspaceId: "ws-1",
      serverId: "s",
      label: "l",
      lastError: "e",
      serviceKey: "infra",
    });
    expect(configStore.resolveRoutingKey).toHaveBeenCalledWith("ws-1", "infra");
  });
});
