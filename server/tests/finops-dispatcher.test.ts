/**
 * Unit tests for the alert channel dispatcher (Epic #47 / Issue #50).
 * Verifies email + webhook routing, body/payload construction, per-channel
 * isolation, and the missing-secret webhook guard.
 */
import { describe, expect, it, vi } from "vitest";

// #614 — hermetic prisma double: no target maps to a METIS user, so email
// channels stay preference-exempt in these transport-routing tests.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notificationPreference: { findMany: vi.fn(async () => []) },
    user: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  },
}));

import {
  buildEmailBody,
  buildWebhookPayload,
  createDispatcher,
} from "../src/lib/finops/channels/dispatcher.js";
import type { AlertNotification, AlertChannelRow } from "../src/lib/finops/alert-engine.js";

const notification: AlertNotification = {
  workspaceId: "w1",
  workspaceName: "Acme",
  ruleName: "80% projected",
  thresholdPct: 80,
  basis: "projected",
  spendCents: 9_000,
  budgetCents: 10_000,
  ratio: 0.9,
  firedAt: "2026-06-15T12:00:00.000Z",
};

describe("buildEmailBody", () => {
  it("includes workspace, threshold, spend, budget, and utilisation", () => {
    const { subject, text } = buildEmailBody(notification);
    expect(subject).toContain("Acme");
    expect(subject).toContain("90%");
    expect(text).toContain("$90.00");
    expect(text).toContain("$100.00");
    expect(text).toContain("80%");
  });
});

describe("buildWebhookPayload", () => {
  it("emits a structured JSON payload", () => {
    const p = buildWebhookPayload(notification);
    expect(p).toMatchObject({
      type: "finops.budget_alert",
      workspaceId: "w1",
      rule: "80% projected",
      ratio: 0.9,
    });
  });
});

describe("createDispatcher", () => {
  it("routes email channels through the email sender", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const dispatcher = createDispatcher({ emailSender: { send } });
    const channels: AlertChannelRow[] = [
      { id: "c1", type: "email", target: "owner@acme.com", secret: null, config: "{}" },
    ];
    const results = await dispatcher(channels, notification);
    expect(results[0]).toMatchObject({ channelId: "c1", ok: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@acme.com" }));
  });

  it("fails a webhook channel that has no signing secret", async () => {
    const dispatcher = createDispatcher({
      emailSender: { send: vi.fn(async () => ({ ok: true })) },
    });
    const channels: AlertChannelRow[] = [
      {
        id: "c2",
        type: "webhook",
        target: "https://hooks.example.com",
        secret: null,
        config: "{}",
      },
    ];
    const results = await dispatcher(channels, notification);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toMatch(/no signing secret/);
  });

  it("flags an unknown channel type without throwing", async () => {
    const dispatcher = createDispatcher({
      emailSender: { send: vi.fn(async () => ({ ok: true })) },
    });
    const channels: AlertChannelRow[] = [
      { id: "c3", type: "carrier-pigeon", target: "x", secret: null, config: "{}" },
    ];
    const results = await dispatcher(channels, notification);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toMatch(/unknown channel type/);
  });

  it("isolates a failing channel from a healthy one", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "smtp down" })
      .mockResolvedValueOnce({ ok: true });
    const dispatcher = createDispatcher({ emailSender: { send } });
    const channels: AlertChannelRow[] = [
      { id: "bad", type: "email", target: "a@b.com", secret: null, config: "{}" },
      { id: "good", type: "email", target: "c@d.com", secret: null, config: "{}" },
    ];
    const results = await dispatcher(channels, notification);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
  });
});
