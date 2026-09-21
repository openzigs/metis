/**
 * Epic #156 (#147) — Trigger HMAC verification unit tests.
 */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  signGenericWebhook,
  verifyGenericWebhook,
  verifyGithubWebhook,
  verifySlackWebhook,
} from "../src/lib/async/triggers.js";

describe("verifyGenericWebhook", () => {
  const secret = "shh-very-secret";
  const body = '{"hello":"world"}';

  it("accepts a valid signature with current timestamp", () => {
    const tsSec = Math.floor(Date.now() / 1000);
    const { signature, timestamp } = signGenericWebhook(body, secret, tsSec);
    const r = verifyGenericWebhook(body, secret, { signature, timestamp });
    expect(r.ok).toBe(true);
  });

  it("rejects when the signature is missing", () => {
    const r = verifyGenericWebhook(body, secret, { timestamp: "100" });
    expect(r).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
  });

  it("rejects when the timestamp is missing", () => {
    const r = verifyGenericWebhook(body, secret, { signature: "x" });
    expect(r).toEqual({ ok: false, reason: "MISSING_TIMESTAMP" });
  });

  it("rejects an expired timestamp (>5 min skew)", () => {
    const tsSec = Math.floor(Date.now() / 1000) - 6 * 60;
    const { signature, timestamp } = signGenericWebhook(body, secret, tsSec);
    const r = verifyGenericWebhook(body, secret, { signature, timestamp });
    expect(r).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects a tampered body (replay attack)", () => {
    const tsSec = Math.floor(Date.now() / 1000);
    const { signature, timestamp } = signGenericWebhook(body, secret, tsSec);
    const r = verifyGenericWebhook('{"hello":"evil"}', secret, { signature, timestamp });
    expect(r).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a wrong secret", () => {
    const tsSec = Math.floor(Date.now() / 1000);
    const { signature, timestamp } = signGenericWebhook(body, secret, tsSec);
    const r = verifyGenericWebhook(body, "different-secret", { signature, timestamp });
    expect(r).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects an empty secret", () => {
    expect(verifyGenericWebhook(body, "", { signature: "x", timestamp: "1" })).toEqual({
      ok: false,
      reason: "MISSING_SECRET",
    });
  });

  it("rejects a non-numeric timestamp", () => {
    const r = verifyGenericWebhook(body, secret, { signature: "x", timestamp: "nope" });
    expect(r).toEqual({ ok: false, reason: "BAD_TIMESTAMP" });
  });

  it("accepts a `sha256=` prefixed signature", () => {
    const tsSec = Math.floor(Date.now() / 1000);
    const { signature } = signGenericWebhook(body, secret, tsSec);
    expect(signature.startsWith("sha256=")).toBe(true);
    const r = verifyGenericWebhook(body, secret, {
      signature,
      timestamp: String(tsSec),
    });
    expect(r.ok).toBe(true);
  });
});

describe("verifyGithubWebhook", () => {
  const secret = "gh-secret";
  const body = '{"action":"opened"}';
  it("accepts a sha256= signature", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGithubWebhook(body, secret, sig).ok).toBe(true);
  });
  it("rejects mismatched signature", () => {
    expect(verifyGithubWebhook(body, secret, "sha256=deadbeef").ok).toBe(false);
  });
  it("rejects when signature header missing", () => {
    expect(verifyGithubWebhook(body, secret, undefined).reason).toBe("MISSING_SIGNATURE");
  });
});

describe("verifySlackWebhook", () => {
  const secret = "slack-secret";
  const body = "token=xxx&team_id=T1";
  it("accepts a v0= signature with current ts", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const base = `v0:${ts}:${body}`;
    const sig = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
    const r = verifySlackWebhook(body, secret, { signature: sig, timestamp: ts });
    expect(r.ok).toBe(true);
  });
  it("rejects expired timestamp", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const base = `v0:${ts}:${body}`;
    const sig = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
    const r = verifySlackWebhook(body, secret, { signature: sig, timestamp: ts });
    expect(r.reason).toBe("EXPIRED");
  });
  it("rejects mismatched body (replay variant)", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const base = `v0:${ts}:${body}`;
    const sig = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
    const r = verifySlackWebhook("token=evil", secret, {
      signature: sig,
      timestamp: ts,
    });
    expect(r.reason).toBe("BAD_SIGNATURE");
  });
});
