/**
 * #1169 — the PR-review budget read's limiter key: the signed-in user, else
 * the TCP peer, never a client-supplied header.
 */
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { prReviewBudgetKey } from "./pr-review-budget-rate-limit.js";

function req(over: Partial<Request> & Record<string, unknown>): Request {
  return {
    headers: {},
    socket: { remoteAddress: "10.0.0.7", remoteFamily: "IPv4" },
    ...over,
  } as unknown as Request;
}

describe("prReviewBudgetKey", () => {
  it("keys a signed-in request on its user", () => {
    expect(prReviewBudgetKey(req({ user: { userId: "u1" } as never }))).toBe("user:u1");
  });

  it("falls back to the TCP peer, ignoring X-Forwarded-For", () => {
    const a = prReviewBudgetKey(req({ headers: { "x-forwarded-for": "1.2.3.4" } }));
    const b = prReviewBudgetKey(req({ headers: { "x-forwarded-for": "5.6.7.8" } }));
    expect(a).toBe("peer:10.0.0.7");
    expect(b).toBe(a);
  });

  it("groups an IPv6 peer by its /64", () => {
    const k = prReviewBudgetKey(
      req({ socket: { remoteAddress: "2001:db8:1:2::9", remoteFamily: "IPv6" } as never }),
    );
    expect(k.startsWith("peer:2001:db8:1:2")).toBe(true);
  });
});
