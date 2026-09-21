/**
 * Issue #580 — sev-1 emission-point hook tests.
 *
 * These are the thin, best-effort functions the three event sources import. Each
 * derives the owning workspace (from a project where the source only has a
 * projectId) and delegates to an injected `PagerDutyAlerter`. They never throw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pagerDutyPublishRollback,
  pagerDutyVaultRotationFailure,
  pagerDutyProviderDown,
  pagerDutyProviderRecovered,
  __resetPagerDutyAlerter,
} from "./alerting-hooks.js";

function makeAlerter() {
  return {
    publishRollback: vi.fn(async () => undefined),
    vaultRotationFailure: vi.fn(async () => undefined),
    providerDown: vi.fn(async () => undefined),
    providerRecovered: vi.fn(async () => undefined),
  };
}

function makeDb(project: { name: string; workspaceId: string | null } | null) {
  return {
    project: { findFirst: vi.fn(async () => project) },
  };
}

describe("pagerDutyPublishRollback", () => {
  it("derives the workspace from the project and triggers", async () => {
    const alerter = makeAlerter();
    const db = makeDb({ name: "Acme", workspaceId: "ws-9" });
    await pagerDutyPublishRollback(
      { batchId: "b1", projectId: "p1", reason: "auto-rollback", repo: "o/r" },
      { alerter: alerter as never, db: db as never },
    );
    expect(alerter.publishRollback).toHaveBeenCalledTimes(1);
    expect(alerter.publishRollback.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws-9",
      projectName: "Acme",
      batchId: "b1",
    });
  });

  it("no-ops when the project has no workspace", async () => {
    const alerter = makeAlerter();
    const db = makeDb({ name: "Acme", workspaceId: null });
    await pagerDutyPublishRollback(
      { batchId: "b1", projectId: "p1", reason: "r", repo: null },
      { alerter: alerter as never, db: db as never },
    );
    expect(alerter.publishRollback).not.toHaveBeenCalled();
  });

  it("never throws even if workspace derivation throws", async () => {
    const alerter = makeAlerter();
    const db = {
      project: {
        findFirst: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    };
    await expect(
      pagerDutyPublishRollback(
        { batchId: "b1", projectId: "p1", reason: "r", repo: null },
        { alerter: alerter as never, db: db as never },
      ),
    ).resolves.toBeUndefined();
    expect(alerter.publishRollback).not.toHaveBeenCalled();
  });
});

describe("pagerDutyVaultRotationFailure", () => {
  it("triggers directly with the supplied workspace (no project derivation)", async () => {
    const alerter = makeAlerter();
    await pagerDutyVaultRotationFailure(
      { workspaceId: "ws-1", secretId: "s1", label: "lbl", reason: "decrypt failed" },
      { alerter: alerter as never },
    );
    expect(alerter.vaultRotationFailure).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      secretId: "s1",
      label: "lbl",
      reason: "decrypt failed",
    });
  });

  it("no-ops without a workspaceId", async () => {
    const alerter = makeAlerter();
    await pagerDutyVaultRotationFailure(
      { workspaceId: "", secretId: "s1", label: "lbl", reason: "r" },
      { alerter: alerter as never },
    );
    expect(alerter.vaultRotationFailure).not.toHaveBeenCalled();
  });

  it("never throws when the alerter throws", async () => {
    const alerter = makeAlerter();
    alerter.vaultRotationFailure.mockRejectedValueOnce(new Error("boom"));
    await expect(
      pagerDutyVaultRotationFailure(
        { workspaceId: "ws-1", secretId: "s1", label: "lbl", reason: "r" },
        { alerter: alerter as never },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("pagerDutyProviderDown / Recovered", () => {
  it("provider down triggers with the supplied workspace", async () => {
    const alerter = makeAlerter();
    await pagerDutyProviderDown(
      { workspaceId: "ws-1", serverId: "srv", label: "fs-mcp", lastError: "closed" },
      { alerter: alerter as never },
    );
    expect(alerter.providerDown).toHaveBeenCalledTimes(1);
  });

  it("provider recovered resolves", async () => {
    const alerter = makeAlerter();
    await pagerDutyProviderRecovered(
      { workspaceId: "ws-1", serverId: "srv" },
      { alerter: alerter as never },
    );
    expect(alerter.providerRecovered).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      serverId: "srv",
    });
  });

  it("provider down no-ops without a workspaceId (provider not workspace-scoped)", async () => {
    const alerter = makeAlerter();
    await pagerDutyProviderDown(
      { workspaceId: "", serverId: "srv", label: "l", lastError: "e" },
      { alerter: alerter as never },
    );
    expect(alerter.providerDown).not.toHaveBeenCalled();
  });

  it("provider recovered no-ops without a workspaceId", async () => {
    const alerter = makeAlerter();
    await pagerDutyProviderRecovered(
      { workspaceId: "", serverId: "srv" },
      { alerter: alerter as never },
    );
    expect(alerter.providerRecovered).not.toHaveBeenCalled();
  });
});

describe("default alerter singleton", () => {
  afterEach(() => __resetPagerDutyAlerter());

  // Exercises defaultAlerter() construction without any network: a blank/missing
  // workspace short-circuits before the real PagerDuty client is ever called.
  it("constructs the default alerter and no-ops on a blank workspace (no overrides)", async () => {
    await expect(
      pagerDutyVaultRotationFailure({ workspaceId: "", secretId: "s", label: "l", reason: "r" }),
    ).resolves.toBeUndefined();
    await expect(
      pagerDutyProviderDown({ workspaceId: "", serverId: "s", label: "l", lastError: "e" }),
    ).resolves.toBeUndefined();
    await expect(
      pagerDutyProviderRecovered({ workspaceId: "", serverId: "s" }),
    ).resolves.toBeUndefined();
  });
});
