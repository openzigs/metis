/**
 * Tests for MFA requirement middleware.
 * Epic #748, Issue #754.
 */
import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireMfa } from "../src/lib/auth/require-mfa.js";

function createMockReq(user?: Record<string, unknown>): Partial<Request> {
  return { user: user as Request["user"] };
}

function createMockRes(): Partial<Response> {
  return {};
}

describe("requireMfa middleware", () => {
  it("passes through when user has mfaPassed=true", () => {
    const req = createMockReq({ userId: "u1", mfaPassed: true });
    const res = createMockRes();
    const next = vi.fn();
    requireMfa(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith();
  });

  it("passes through when mfaPassed is undefined (non-SSO session)", () => {
    const req = createMockReq({ userId: "u1", username: "admin", role: "admin", permissions: [] });
    const res = createMockRes();
    const next = vi.fn();
    requireMfa(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith();
  });

  it("blocks when mfaPassed is explicitly false", () => {
    const req = createMockReq({ userId: "u1", mfaPassed: false });
    const res = createMockRes();
    const next = vi.fn();
    requireMfa(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("MFA_REQUIRED");
  });

  it("returns 401 when no user on request", () => {
    const req = createMockReq(undefined);
    const res = createMockRes();
    const next = vi.fn();
    requireMfa(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
  });
});
