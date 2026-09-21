/**
 * Alert-channel selection validation (#51). The channel schema now accepts
 * email/webhook/slack/pagerduty and enforces per-type config. Unit-tested in
 * isolation (no HTTP/auth/prisma needed) — the schema is the changed logic.
 */
import { describe, it, expect } from "vitest";

import { channelSchema } from "./finops-workspace.js";

describe("channelSchema (#51 channel selection)", () => {
  it("accepts an email channel with a target", () => {
    const r = channelSchema.safeParse({ type: "email", target: "ops@acme.test" });
    expect(r.success).toBe(true);
  });

  it("rejects an email channel with no target", () => {
    const r = channelSchema.safeParse({ type: "email", target: "" });
    expect(r.success).toBe(false);
  });

  it("accepts a webhook channel with a target", () => {
    const r = channelSchema.safeParse({ type: "webhook", target: "https://hook.test" });
    expect(r.success).toBe(true);
  });

  it("accepts a slack channel with the channel id in target", () => {
    const r = channelSchema.safeParse({ type: "slack", target: "C123" });
    expect(r.success).toBe(true);
  });

  it("accepts a slack channel with the channel id in config.channel", () => {
    const r = channelSchema.safeParse({ type: "slack", config: '{"channel":"C999"}' });
    expect(r.success).toBe(true);
  });

  it("rejects a slack channel with no target and no config.channel", () => {
    const r = channelSchema.safeParse({ type: "slack" });
    expect(r.success).toBe(false);
  });

  it("accepts a pagerduty channel with an empty config (default service)", () => {
    const r = channelSchema.safeParse({ type: "pagerduty" });
    expect(r.success).toBe(true);
  });

  it("accepts a pagerduty channel with a serviceKey in config", () => {
    const r = channelSchema.safeParse({ type: "pagerduty", config: '{"serviceKey":"finops"}' });
    expect(r.success).toBe(true);
  });

  it("rejects any channel with malformed config JSON", () => {
    const r = channelSchema.safeParse({ type: "pagerduty", config: "{not json" });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown channel type", () => {
    const r = channelSchema.safeParse({ type: "carrier-pigeon", target: "x" });
    expect(r.success).toBe(false);
  });
});
