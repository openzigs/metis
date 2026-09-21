/**
 * FinOps Slack sender tests (#51). Verifies per-workspace token resolution, Block
 * Kit formatting, the empty-target guard, the no-install no-op, and that a Slack
 * API error surfaces as ok:false (not a throw).
 */
import { describe, it, expect, vi } from "vitest";

import type { AlertNotification } from "../alert-engine.js";
import { sendSlackAlert } from "./slack-sender.js";

// Mock the Slack SDK so the DEFAULT `chat.postMessage` transport (the lazy
// `@slack/web-api` import) can be exercised without a live workspace.
const postMessageSpy = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    public chat = { postMessage: postMessageSpy };
    constructor(public token?: string) {}
  },
}));

const notification: AlertNotification = {
  workspaceId: "ws-1",
  workspaceName: "Acme",
  ruleId: "rule-1",
  ruleName: "100% projected",
  thresholdPct: 100,
  basis: "projected",
  spendCents: 10_500,
  budgetCents: 10_000,
  ratio: 1.05,
  firedAt: "2026-07-01T00:00:00.000Z",
};

describe("sendSlackAlert", () => {
  it("resolves the per-workspace token and posts a Block Kit message", async () => {
    const resolveBotToken = vi
      .fn()
      .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb-ws1", botUserId: null });
    const postMessage = vi.fn().mockResolvedValue({ ok: true });

    const res = await sendSlackAlert(notification, "C123", {
      store: { resolveBotToken } as never,
      postMessage,
    });

    expect(res.ok).toBe(true);
    expect(resolveBotToken).toHaveBeenCalledWith("ws-1");
    const arg = postMessage.mock.calls[0][0];
    expect(arg.token).toBe("xoxb-ws1");
    expect(arg.channel).toBe("C123");
    expect(arg.blocks.length).toBeGreaterThan(0);
    expect(arg.text).toContain("105%");
  });

  it("returns ok:false for an empty channel target", async () => {
    const resolveBotToken = vi.fn();
    const res = await sendSlackAlert(notification, "  ", {
      store: { resolveBotToken } as never,
      postMessage: vi.fn(),
    });
    expect(res.ok).toBe(false);
    expect(resolveBotToken).not.toHaveBeenCalled();
  });

  it("is a no-op (ok:false) when there is no active Slack installation", async () => {
    const res = await sendSlackAlert(notification, "C1", {
      store: { resolveBotToken: vi.fn().mockResolvedValue(null) } as never,
      postMessage: vi.fn(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no active Slack installation/);
  });

  it("uses the default @slack/web-api transport when no postMessage is injected", async () => {
    postMessageSpy.mockResolvedValue({ ok: true });
    const res = await sendSlackAlert(notification, "C1", {
      store: {
        resolveBotToken: vi
          .fn()
          .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb-real", botUserId: null }),
      } as never,
    });
    expect(res.ok).toBe(true);
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", blocks: expect.any(Array) }),
    );
  });

  it("surfaces a Slack API error as ok:false with the error code", async () => {
    const res = await sendSlackAlert(notification, "C1", {
      store: {
        resolveBotToken: vi
          .fn()
          .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb", botUserId: null }),
      } as never,
      postMessage: vi.fn().mockResolvedValue({ ok: false, error: "channel_not_found" }),
    });
    expect(res).toEqual({ ok: false, error: "channel_not_found" });
  });
});
