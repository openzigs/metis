import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  REPLAY_WINDOW_SECONDS,
  verifySlackSignature,
  type SlackSignatureHeaders,
} from "./signature.js";

// A throwaway, obviously-fake signing secret for these tests — NOT a real
// credential. (Kept human-readable so secret scanners don't flag a hex blob.)
const SIGNING_SECRET = "test-fake-slack-signing-secret-not-real";

/** Build a genuine Slack `v0=` signature for a body at a given timestamp. */
function sign(body: string, tsSeconds: number, secret = SIGNING_SECRET): string {
  const base = `v0:${tsSeconds}:${body}`;
  const hmac = crypto.createHmac("sha256", secret).update(base).digest("hex");
  return `v0=${hmac}`;
}

function headers(sig: string | undefined, ts: string | undefined): SlackSignatureHeaders {
  return { signature: sig, timestamp: ts };
}

describe("issue #579 — verifySlackSignature", () => {
  const nowMs = 1_700_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const body = "token=xyz&command=%2Fmetis&text=status";

  it("accepts a correctly-signed, fresh request", () => {
    const sig = sign(body, nowSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, String(nowSec)),
      nowMs,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a request with a missing signature header", () => {
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(undefined, String(nowSec)),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects a request with a missing timestamp header", () => {
    const sig = sign(body, nowSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, undefined),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("rejects a non-numeric timestamp (untrusted input)", () => {
    const sig = sign(body, nowSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, "not-a-number"),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects a zero/negative timestamp", () => {
    const sig = sign(body, nowSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, "0"),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects a STALE request (older than the replay window) even when signed", () => {
    const staleSec = nowSec - (REPLAY_WINDOW_SECONDS + 60);
    const sig = sign(body, staleSec); // a valid signature for the OLD timestamp
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, String(staleSec)),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a far-FUTURE timestamp (clock-skew abuse) even when signed", () => {
    const futureSec = nowSec + (REPLAY_WINDOW_SECONDS + 60);
    const sig = sign(body, futureSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, String(futureSec)),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts a request right at the edge of the replay window", () => {
    const edgeSec = nowSec - REPLAY_WINDOW_SECONDS;
    const sig = sign(body, edgeSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, String(edgeSec)),
      nowMs,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const sig = sign(body, nowSec);
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body + "&tampered=1",
      headers: headers(sig, String(nowSec)),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature produced with the WRONG signing secret", () => {
    const sig = sign(body, nowSec, "the-wrong-secret-aaaaaaaaaaaaaaaa");
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers(sig, String(nowSec)),
      nowMs,
    });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a malformed (non v0=) signature without throwing", () => {
    const res = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: body,
      headers: headers("garbage", String(nowSec)),
      nowMs,
    });
    expect(res.ok).toBe(false);
  });
});
