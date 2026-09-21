/**
 * FinOps PagerDuty sender tests (#51). Verifies per-workspace routing-key
 * resolution, the stable dedup key, non-critical severity mapping, default
 * service-key fallback, sanitized custom details (no secrets), and the no-config
 * no-op.
 */
import { describe, it, expect, vi } from "vitest";

import type { AlertNotification } from "../alert-engine.js";
import { sendPagerDutyAlert, budgetDedupKey, budgetSeverity } from "./pagerduty-sender.js";

const notification: AlertNotification = {
  workspaceId: "ws-1",
  workspaceName: "Acme",
  ruleId: "rule-1",
  ruleName: "80% projected",
  thresholdPct: 80,
  basis: "projected",
  spendCents: 8_000,
  budgetCents: 10_000,
  ratio: 0.8,
  firedAt: "2026-07-01T00:00:00.000Z",
};

describe("budgetSeverity", () => {
  it("maps < 100% to warning and >= 100% to error, never critical", () => {
    expect(budgetSeverity(0.5)).toBe("warning");
    expect(budgetSeverity(0.99)).toBe("warning");
    expect(budgetSeverity(1)).toBe("error");
    expect(budgetSeverity(2)).toBe("error");
  });
});

describe("budgetDedupKey", () => {
  it("is stable per (workspace, rule)", () => {
    expect(budgetDedupKey("ws-1", "rule-1")).toBe("metis:finops-budget:ws-1:rule-1");
  });
});

describe("sendPagerDutyAlert", () => {
  it("triggers with the per-workspace routing key, dedup key, and warning severity", async () => {
    const resolveRoutingKey = vi.fn().mockResolvedValue("RK-ws1");
    const trigger = vi.fn().mockResolvedValue({});

    const res = await sendPagerDutyAlert(notification, "finops", {
      configStore: { resolveRoutingKey } as never,
      client: { trigger },
    });

    expect(res.ok).toBe(true);
    expect(resolveRoutingKey).toHaveBeenCalledWith("ws-1", "finops");
    const arg = trigger.mock.calls[0][0];
    expect(arg.routingKey).toBe("RK-ws1");
    expect(arg.dedupKey).toBe("metis:finops-budget:ws-1:rule-1");
    expect(arg.severity).toBe("warning");
    expect(arg.source).toBe("metis/finops");
    // custom details carry ids/figures but NEVER the routing key.
    expect(arg.customDetails.workspaceId).toBe("ws-1");
    expect(JSON.stringify(arg.customDetails)).not.toContain("RK-ws1");
  });

  it("falls back to the default service key when none is configured", async () => {
    const resolveRoutingKey = vi.fn().mockResolvedValue("RK");
    const trigger = vi.fn().mockResolvedValue({});
    await sendPagerDutyAlert(notification, undefined, {
      configStore: { resolveRoutingKey } as never,
      client: { trigger },
    });
    expect(resolveRoutingKey).toHaveBeenCalledWith("ws-1", "default");
  });

  it("is a no-op (ok:false) when there is no active PagerDuty config", async () => {
    const trigger = vi.fn();
    const res = await sendPagerDutyAlert(notification, undefined, {
      configStore: { resolveRoutingKey: vi.fn().mockResolvedValue(null) } as never,
      client: { trigger },
    });
    expect(res.ok).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });
});
