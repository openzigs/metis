/**
 * Epic #192 (A.3 + A.5) — webhook verification + dispatch tests.
 */
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchGithubPrEvent,
  verifyGithubPrSignature,
  type DispatchHandlers,
} from "./webhook.js";

function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyGithubPrSignature", () => {
  const secret = "webhook-secret";
  const body = JSON.stringify({ action: "opened", pull_request: { number: 1 } });

  it("rejects missing secret/signature", () => {
    expect(verifyGithubPrSignature(body, "", { signature: sign(body, secret) }).ok).toBe(false);
    expect(verifyGithubPrSignature(body, secret, {}).ok).toBe(false);
  });

  it("accepts a correctly signed payload", () => {
    const r = verifyGithubPrSignature(body, secret, { signature: sign(body, secret) });
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const r = verifyGithubPrSignature("tampered", secret, { signature: sign(body, secret) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("BAD_SIGNATURE");
  });

  it("validates optional timestamp skew when provided", () => {
    const now = Date.now();
    const sig = sign(body, secret);
    const ts = Math.floor(now / 1000).toString();
    const fresh = verifyGithubPrSignature(body, secret, { signature: sig, timestamp: ts }, now);
    expect(fresh.ok).toBe(true);
    const stale = verifyGithubPrSignature(
      body,
      secret,
      { signature: sig, timestamp: String(Math.floor(now / 1000) - 60 * 60) },
      now,
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("EXPIRED");
    const bogus = verifyGithubPrSignature(
      body,
      secret,
      { signature: sig, timestamp: "not-a-number" },
      now,
    );
    expect(bogus.ok).toBe(false);
    expect(bogus.reason).toBe("BAD_TIMESTAMP");
  });

  it("rejects malformed hex signatures", () => {
    const r = verifyGithubPrSignature(body, secret, { signature: "sha256=zzz" });
    expect(r.ok).toBe(false);
  });
});

describe("dispatchGithubPrEvent", () => {
  const repo = { full_name: "acme/proj", html_url: "https://github.com/acme/proj" };

  function handlers(): {
    handlers: DispatchHandlers;
    merged: ReturnType<typeof vi.fn>;
    reviewable: ReturnType<typeof vi.fn>;
  } {
    const merged = vi.fn(async () => undefined);
    const reviewable = vi.fn(async () => undefined);
    return { handlers: { onMerged: merged, onReviewable: reviewable }, merged, reviewable };
  }

  it("returns NOT handled when pr or repo missing", async () => {
    const { handlers: h } = handlers();
    expect(await dispatchGithubPrEvent({ action: "opened" }, h)).toEqual({
      handled: false,
      reason: "MISSING_PR_OR_REPO",
    });
  });

  it("calls onMerged for closed+merged", async () => {
    const { handlers: h, merged } = handlers();
    const out = await dispatchGithubPrEvent(
      { action: "closed", pull_request: { number: 7, merged: true }, repository: repo },
      h,
    );
    expect(merged).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ handled: true, kind: "merged" });
  });

  it("ignores closed without merged:true", async () => {
    const { handlers: h, merged } = handlers();
    const out = await dispatchGithubPrEvent(
      { action: "closed", pull_request: { number: 7, merged: false }, repository: repo },
      h,
    );
    expect(merged).not.toHaveBeenCalled();
    expect(out).toEqual({ handled: false, reason: "PR_NOT_MERGED" });
  });

  it("calls onReviewable for opened/synchronize/reopened", async () => {
    for (const action of ["opened", "synchronize", "reopened"] as const) {
      const { handlers: h, reviewable } = handlers();
      const out = await dispatchGithubPrEvent(
        { action, pull_request: { number: 1 }, repository: repo },
        h,
      );
      expect(reviewable).toHaveBeenCalledWith(expect.objectContaining({ action }));
      expect(out).toMatchObject({ handled: true, kind: "reviewable", action });
    }
  });

  it("returns UNHANDLED_ACTION for other actions", async () => {
    const { handlers: h } = handlers();
    const out = await dispatchGithubPrEvent(
      { action: "labeled", pull_request: { number: 1 }, repository: repo },
      h,
    );
    expect(out).toEqual({ handled: false, reason: "UNHANDLED_ACTION:labeled" });
  });
});
