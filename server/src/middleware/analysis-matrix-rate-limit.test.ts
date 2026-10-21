/**
 * #838 — the analysis matrix limiters: what each one's KEY is. That they sit
 * on the matrix and export routes, and 429 past the budget, is asserted on the
 * real router in `routes/analysis-traceability.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";
import {
  ANALYSIS_MATRIX_DEFAULT_MAX,
  ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX,
  analysisMatrixPreAuthKey,
  analysisMatrixUserKey,
} from "./analysis-matrix-rate-limit.js";

/** A request as a key function sees it. `ip` is what a client-supplied header would make it. */
const req = (over: {
  ip?: string;
  authorization?: string;
  cookie?: string;
  userId?: string;
  peer?: string;
  family?: string;
}): Request =>
  ({
    ip: over.ip ?? "203.0.113.200",
    headers: {
      ...(over.authorization ? { authorization: over.authorization } : {}),
      "x-forwarded-for": over.ip ?? "203.0.113.200",
    },
    cookies: over.cookie ? { accessToken: over.cookie } : {},
    user: over.userId ? { userId: over.userId } : undefined,
    socket: { remoteAddress: over.peer ?? "10.0.0.5", remoteFamily: over.family ?? "IPv4" },
  }) as unknown as Request;

const tokensFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  });

describe("analysisMatrixUserKey", () => {
  it("is the signed-in user, whatever address the request claims", () => {
    expect(analysisMatrixUserKey(req({ userId: "u-a", ip: "198.51.100.1" }))).toBe("user:u-a");
    expect(analysisMatrixUserKey(req({ userId: "u-a", ip: "198.51.100.2" }))).toBe("user:u-a");
  });

  it("without a user is the TCP peer, never the forwarded address", () => {
    const a = analysisMatrixUserKey(req({ ip: "198.51.100.1", peer: "10.0.0.1" }));
    expect(a).toBe("peer:10.0.0.1");
    expect(analysisMatrixUserKey(req({ ip: "198.51.100.99", peer: "10.0.0.1" }))).toBe(a);
  });

  it("groups an IPv6 peer by its /64", () => {
    const a = analysisMatrixUserKey(req({ peer: "2001:db8:1:1::1", family: "IPv6" }));
    expect(analysisMatrixUserKey(req({ peer: "2001:db8:1:1::2", family: "IPv6" }))).toBe(a);
  });
});

describe("analysisMatrixPreAuthKey", () => {
  it("a token this server signed is its user, from the header or the cookie", () => {
    const { accessToken } = tokensFor("u-alice");
    expect(analysisMatrixPreAuthKey(req({ authorization: `Bearer ${accessToken}` }))).toBe(
      "preauth:user:u-alice",
    );
    expect(analysisMatrixPreAuthKey(req({ cookie: accessToken }))).toBe("preauth:user:u-alice");
  });

  it("an EXPIRED token we signed is still its user's", () => {
    const { accessToken } = tokensFor("u-alice");
    const payload = jwt.decode(accessToken) as Record<string, unknown>;
    const expired = jwt.sign(
      { ...payload, iat: 1_000, exp: 2_000 },
      process.env.JWT_SECRET as string,
    );
    expect(analysisMatrixPreAuthKey(req({ authorization: `Bearer ${expired}` }))).toBe(
      "preauth:user:u-alice",
    );
  });

  it("a token we did not sign, an empty bearer, or none at all is the peer", () => {
    const forged = jwt.sign({ userId: "u-alice" }, "x".repeat(40));
    const peer = "preauth:peer:10.0.0.1";
    expect(analysisMatrixPreAuthKey(req({ peer: "10.0.0.1" }))).toBe(peer);
    expect(
      analysisMatrixPreAuthKey(req({ authorization: `Bearer ${forged}`, peer: "10.0.0.1" })),
    ).toBe(peer);
    expect(analysisMatrixPreAuthKey(req({ authorization: "Bearer  ", peer: "10.0.0.1" }))).toBe(
      peer,
    );
    expect(analysisMatrixPreAuthKey(req({ ip: "198.51.100.7", peer: "10.0.0.1" }))).toBe(peer);
  });

  it("is never the user limiter's key for the same request", () => {
    const { accessToken } = tokensFor("u-alice");
    const signedIn = req({ authorization: `Bearer ${accessToken}`, userId: "u-alice" });
    expect(analysisMatrixPreAuthKey(signedIn)).not.toBe(analysisMatrixUserKey(signedIn));
  });
});

describe("defaults", () => {
  it("the pre-auth guard is coarser than the user budget", () => {
    expect(ANALYSIS_MATRIX_DEFAULT_MAX).toBe(300);
    expect(ANALYSIS_MATRIX_PREAUTH_DEFAULT_MAX).toBeGreaterThan(ANALYSIS_MATRIX_DEFAULT_MAX);
  });
});
