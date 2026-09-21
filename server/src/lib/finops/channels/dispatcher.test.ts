/**
 * Dispatcher tests (#50 + #51). Covers the full channel matrix: email, webhook,
 * slack, pagerduty; multiple channels on one alert; per-channel best-effort
 * isolation (one channel throwing must not abort the others); and the no-config
 * no-op paths for slack/pagerduty.
 *
 * The Slack + PagerDuty senders are exercised through their INJECTED deps
 * (`deps.slack`, `deps.pagerDuty`) so no live Slack/PagerDuty client is touched.
 *
 * #614 — email channels whose target maps to a METIS user enforce that user's
 * `email × systemAlerts` preference via the REAL `shouldNotifyEmailRecipient`
 * (prisma is mocked). Webhook/Slack/PagerDuty channels and non-user email
 * targets are preference-exempt (see NOTIFICATION_PREFERENCE_EXEMPTIONS).
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

const { prefFindMany, userFindFirst, userFindMany } = vi.hoisted(() => ({
  prefFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
}));
vi.mock("../../prisma.js", () => ({
  prisma: {
    notificationPreference: { findMany: prefFindMany },
    user: { findFirst: userFindFirst, findMany: userFindMany },
  },
  // #634 — email-recipient resolution splits by DB adapter; these tests exercise
  // the SQLite path (findFirst/findMany above).
  resolveDatabaseProvider: () => "sqlite",
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));

import type { AlertChannelRow, AlertNotification } from "../alert-engine.js";
import { createDispatcher } from "./dispatcher.js";
import type { EmailSender } from "./email-sender.js";

beforeEach(() => {
  prefFindMany.mockReset();
  userFindFirst.mockReset();
  userFindMany.mockReset();
  // #614 defaults: target maps to no METIS user → preference-exempt (send).
  prefFindMany.mockResolvedValue([]);
  userFindFirst.mockResolvedValue(null);
  userFindMany.mockResolvedValue([]);
});

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

function channel(over: Partial<AlertChannelRow>): AlertChannelRow {
  return { id: "c", type: "email", target: "", secret: null, config: "{}", ...over };
}

const okEmail: EmailSender = { send: vi.fn().mockResolvedValue({ ok: true }) };

describe("createDispatcher — email + webhook (existing behavior)", () => {
  it("sends an email with the formatted subject/body", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const dispatch = createDispatcher({ emailSender: { send } });
    const [res] = await dispatch(
      [channel({ id: "e1", type: "email", target: "ops@acme.test" })],
      notification,
    );
    expect(res).toMatchObject({ channelId: "e1", type: "email", ok: true });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ops@acme.test", subject: expect.stringContaining("Acme") }),
    );
  });

  it("fails a webhook channel with no signing secret (not a crash)", async () => {
    const dispatch = createDispatcher({ emailSender: okEmail });
    const [res] = await dispatch(
      [channel({ id: "w1", type: "webhook", target: "https://x.test", secret: null })],
      notification,
    );
    expect(res).toMatchObject({ channelId: "w1", type: "webhook", ok: false });
  });
});

describe("createDispatcher — email preference enforcement (#614)", () => {
  it("suppresses (ok:true, suppressed:true) when the target maps to a user who disabled email × systemAlerts", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    userFindFirst.mockResolvedValue({ id: "u1" });
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);

    const dispatch = createDispatcher({ emailSender: { send } });
    const [res] = await dispatch(
      [channel({ id: "e1", type: "email", target: "bob@acme.test" })],
      notification,
    );

    expect(send).not.toHaveBeenCalled();
    expect(res).toMatchObject({ channelId: "e1", type: "email", ok: true, suppressed: true });
    expect(prefFindMany).toHaveBeenCalledWith({
      where: { userId: "u1", channel: "email", event: "systemAlerts" },
    });
  });

  it("sends when the target maps to a user with default (enabled) preferences", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    userFindFirst.mockResolvedValue({ id: "u1" });

    const dispatch = createDispatcher({ emailSender: { send } });
    const [res] = await dispatch(
      [channel({ id: "e1", type: "email", target: "bob@acme.test" })],
      notification,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true });
    expect(res.suppressed).toBeUndefined();
  });

  it("sends when the target does NOT map to a METIS user (exempt — shared mailbox / dist list)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    // userFindFirst/userFindMany default to no match.
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);

    const dispatch = createDispatcher({ emailSender: { send } });
    const [res] = await dispatch(
      [channel({ id: "e1", type: "email", target: "ops-list@acme.test" })],
      notification,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true });
    expect(prefFindMany).not.toHaveBeenCalled();
  });

  it("FAILS OPEN and sends when the user lookup throws", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    userFindFirst.mockRejectedValue(new Error("db down"));

    const dispatch = createDispatcher({ emailSender: { send } });
    const [res] = await dispatch(
      [channel({ id: "e1", type: "email", target: "bob@acme.test" })],
      notification,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true });
  });

  it("never consults user preferences for webhook/slack/pagerduty channels (exempt by design)", async () => {
    const resolveBotToken = vi
      .fn()
      .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb", botUserId: null });
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const resolveRoutingKey = vi.fn().mockResolvedValue("RK");
    const trigger = vi.fn().mockResolvedValue({});
    prefFindMany.mockResolvedValue([{ channel: "webhook", event: "systemAlerts", enabled: false }]);

    const dispatch = createDispatcher({
      emailSender: okEmail,
      slack: { store: { resolveBotToken } as never, postMessage },
      pagerDuty: { configStore: { resolveRoutingKey } as never, client: { trigger } },
    });
    const results = await dispatch(
      [
        channel({ id: "s1", type: "slack", target: "C1" }),
        channel({ id: "p1", type: "pagerduty" }),
      ],
      notification,
    );

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(prefFindMany).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
  });
});

describe("createDispatcher — slack channel (#51)", () => {
  it("posts a Block Kit message with the resolved workspace bot token", async () => {
    const resolveBotToken = vi.fn().mockResolvedValue({
      slackTeamId: "T1",
      botToken: "xoxb-ws1",
      botUserId: "B1",
    });
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const dispatch = createDispatcher({
      emailSender: okEmail,
      slack: { store: { resolveBotToken } as never, postMessage },
    });

    const [res] = await dispatch(
      [channel({ id: "s1", type: "slack", target: "C123" })],
      notification,
    );

    expect(res).toMatchObject({ channelId: "s1", type: "slack", ok: true });
    expect(resolveBotToken).toHaveBeenCalledWith("ws-1"); // per-workspace token
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "xoxb-ws1",
        channel: "C123",
        blocks: expect.any(Array),
        text: expect.stringContaining("Acme"),
      }),
    );
  });

  it("prefers config.channel over target when present", async () => {
    const resolveBotToken = vi
      .fn()
      .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb-ws1", botUserId: null });
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const dispatch = createDispatcher({
      emailSender: okEmail,
      slack: { store: { resolveBotToken } as never, postMessage },
    });
    await dispatch(
      [channel({ id: "s1", type: "slack", target: "C-old", config: '{"channel":"C-new"}' })],
      notification,
    );
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C-new" }));
  });

  it("is a logged no-op (ok:false) when the workspace has no Slack install", async () => {
    const resolveBotToken = vi.fn().mockResolvedValue(null);
    const postMessage = vi.fn();
    const dispatch = createDispatcher({
      emailSender: okEmail,
      slack: { store: { resolveBotToken } as never, postMessage },
    });
    const [res] = await dispatch(
      [channel({ id: "s1", type: "slack", target: "C123" })],
      notification,
    );
    expect(res).toMatchObject({ channelId: "s1", type: "slack", ok: false });
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("createDispatcher — pagerduty channel (#51)", () => {
  it("triggers with the resolved routing key, stable dedup key, and non-critical severity", async () => {
    const resolveRoutingKey = vi.fn().mockResolvedValue("R0UTING");
    const trigger = vi.fn().mockResolvedValue({});
    const dispatch = createDispatcher({
      emailSender: okEmail,
      pagerDuty: { configStore: { resolveRoutingKey } as never, client: { trigger } },
    });

    const [res] = await dispatch(
      [channel({ id: "p1", type: "pagerduty", config: '{"serviceKey":"finops"}' })],
      notification,
    );

    expect(res).toMatchObject({ channelId: "p1", type: "pagerduty", ok: true });
    expect(resolveRoutingKey).toHaveBeenCalledWith("ws-1", "finops"); // per-workspace routing key
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        routingKey: "R0UTING",
        dedupKey: "metis:finops-budget:ws-1:rule-1", // stable per rule
        severity: "warning", // 80% → warning, not critical
        source: "metis/finops",
        component: "finops",
      }),
    );
  });

  it("uses severity error when over 100% of budget", async () => {
    const resolveRoutingKey = vi.fn().mockResolvedValue("R0UTING");
    const trigger = vi.fn().mockResolvedValue({});
    const dispatch = createDispatcher({
      emailSender: okEmail,
      pagerDuty: { configStore: { resolveRoutingKey } as never, client: { trigger } },
    });
    await dispatch([channel({ id: "p1", type: "pagerduty" })], { ...notification, ratio: 1.1 });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ severity: "error" }));
  });

  it("is a logged no-op (ok:false) when the workspace has no PagerDuty config", async () => {
    const resolveRoutingKey = vi.fn().mockResolvedValue(null);
    const trigger = vi.fn();
    const dispatch = createDispatcher({
      emailSender: okEmail,
      pagerDuty: { configStore: { resolveRoutingKey } as never, client: { trigger } },
    });
    const [res] = await dispatch([channel({ id: "p1", type: "pagerduty" })], notification);
    expect(res).toMatchObject({ channelId: "p1", type: "pagerduty", ok: false });
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("createDispatcher — fan-out + isolation", () => {
  it("dispatches to every configured channel of a multi-channel rule", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const resolveBotToken = vi
      .fn()
      .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb", botUserId: null });
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const resolveRoutingKey = vi.fn().mockResolvedValue("RK");
    const trigger = vi.fn().mockResolvedValue({});

    const dispatch = createDispatcher({
      emailSender: { send },
      slack: { store: { resolveBotToken } as never, postMessage },
      pagerDuty: { configStore: { resolveRoutingKey } as never, client: { trigger } },
    });

    const results = await dispatch(
      [
        channel({ id: "e1", type: "email", target: "a@b.test" }),
        channel({ id: "s1", type: "slack", target: "C1" }),
        channel({ id: "p1", type: "pagerduty" }),
      ],
      notification,
    );

    expect(results.map((r) => [r.type, r.ok])).toEqual([
      ["email", true],
      ["slack", true],
      ["pagerduty", true],
    ]);
    expect(send).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledOnce();
  });

  it("one channel throwing does not abort the others (per-channel best-effort)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const postMessage = vi.fn().mockRejectedValue(new Error("slack 500"));
    const resolveBotToken = vi
      .fn()
      .mockResolvedValue({ slackTeamId: "T1", botToken: "xoxb", botUserId: null });

    const dispatch = createDispatcher({
      emailSender: { send },
      slack: { store: { resolveBotToken } as never, postMessage },
    });

    const results = await dispatch(
      [
        channel({ id: "s1", type: "slack", target: "C1" }),
        channel({ id: "e1", type: "email", target: "a@b.test" }),
      ],
      notification,
    );

    expect(results[0]).toMatchObject({ channelId: "s1", ok: false, error: "slack 500" });
    expect(results[1]).toMatchObject({ channelId: "e1", ok: true }); // still dispatched
  });

  it("reports an unknown channel type as a failed result, not a crash", async () => {
    const dispatch = createDispatcher({ emailSender: okEmail });
    const [res] = await dispatch([channel({ id: "x", type: "carrier-pigeon" })], notification);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown channel type"),
    });
  });
});
