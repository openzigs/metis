/**
 * Issue #69 — tests for the Slack + PagerDuty integration API wrappers.
 *
 * Verifies each wrapper hits the correct EXISTING backend path/method, that a
 * missing Slack install (404) resolves to `null` rather than throwing, and that
 * the admin-gating helper returns the right answer.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError } from "@/lib/api-client";
import {
  canManageIntegrations,
  listIntegrationWorkspaces,
  pagerDutyIntegrationApi,
  slackIntegrationApi,
} from "@/lib/notification-integrations-api";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, apiFetch };
});

beforeEach(() => {
  apiFetch.mockReset();
});

describe("slackIntegrationApi", () => {
  it("getInstallation returns the summary on success", async () => {
    apiFetch.mockResolvedValue({ id: "i1", slackTeamId: "T1" });
    const res = await slackIntegrationApi.getInstallation("w1");
    expect(res).toEqual({ id: "i1", slackTeamId: "T1" });
    expect(apiFetch).toHaveBeenCalledWith("/integrations/slack/workspaces/w1/installation");
  });

  it("getInstallation returns null on a 404 (not installed)", async () => {
    apiFetch.mockRejectedValue(new ApiError(404, "SLACK_NOT_INSTALLED"));
    await expect(slackIntegrationApi.getInstallation("w1")).resolves.toBeNull();
  });

  it("getInstallation rethrows non-404 errors", async () => {
    apiFetch.mockRejectedValue(new ApiError(500, "boom"));
    await expect(slackIntegrationApi.getInstallation("w1")).rejects.toBeInstanceOf(ApiError);
  });

  it("authorize fetches the authorize URL", async () => {
    apiFetch.mockResolvedValue({ url: "https://slack.example/oauth" });
    const res = await slackIntegrationApi.authorize("w1");
    expect(res.url).toContain("slack.example");
    expect(apiFetch).toHaveBeenCalledWith("/integrations/slack/workspaces/w1/authorize");
  });

  it("install POSTs the token to the install endpoint", async () => {
    apiFetch.mockResolvedValue({ id: "i1" });
    await slackIntegrationApi.install("w1", { slackTeamId: "T1", botToken: "xoxb-secret" });
    expect(apiFetch).toHaveBeenCalledWith("/integrations/slack/workspaces/w1/install", {
      method: "POST",
      body: { slackTeamId: "T1", botToken: "xoxb-secret" },
    });
  });

  it("uninstall DELETEs the installation", async () => {
    apiFetch.mockResolvedValue({ deleted: true });
    await slackIntegrationApi.uninstall("w1");
    expect(apiFetch).toHaveBeenCalledWith("/integrations/slack/workspaces/w1/installation", {
      method: "DELETE",
    });
  });

  it("encodes the workspace id in the path", async () => {
    apiFetch.mockResolvedValue({ url: "x" });
    await slackIntegrationApi.authorize("a/b");
    expect(apiFetch).toHaveBeenCalledWith("/integrations/slack/workspaces/a%2Fb/authorize");
  });
});

describe("pagerDutyIntegrationApi", () => {
  it("listServiceConfigs GETs the service-configs endpoint", async () => {
    apiFetch.mockResolvedValue([]);
    await pagerDutyIntegrationApi.listServiceConfigs("w1");
    expect(apiFetch).toHaveBeenCalledWith("/integrations/pagerduty/workspaces/w1/service-configs");
  });

  it("registerServiceConfig POSTs the routing key", async () => {
    apiFetch.mockResolvedValue({ id: "c1" });
    await pagerDutyIntegrationApi.registerServiceConfig("w1", {
      serviceKey: "prod",
      routingKey: "R0SECRET",
      label: "Prod",
    });
    expect(apiFetch).toHaveBeenCalledWith("/integrations/pagerduty/workspaces/w1/service-configs", {
      method: "POST",
      body: { serviceKey: "prod", routingKey: "R0SECRET", label: "Prod" },
    });
  });

  it("deleteServiceConfig DELETEs the service and encodes the key", async () => {
    apiFetch.mockResolvedValue({ deleted: true });
    await pagerDutyIntegrationApi.deleteServiceConfig("w1", "a b");
    expect(apiFetch).toHaveBeenCalledWith(
      "/integrations/pagerduty/workspaces/w1/service-configs/a%20b",
      { method: "DELETE" },
    );
  });
});

describe("listIntegrationWorkspaces", () => {
  it("GETs /workspaces", async () => {
    apiFetch.mockResolvedValue([{ id: "w1", name: "WS", slug: "ws", role: "admin" }]);
    const res = await listIntegrationWorkspaces();
    expect(res).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledWith("/workspaces");
  });
});

describe("canManageIntegrations", () => {
  it("allows admins and owners", () => {
    expect(canManageIntegrations("admin")).toBe(true);
    expect(canManageIntegrations("owner")).toBe(true);
  });
  it("denies members and unknown roles", () => {
    expect(canManageIntegrations("member")).toBe(false);
    expect(canManageIntegrations(undefined)).toBe(false);
    expect(canManageIntegrations("viewer")).toBe(false);
  });
});
