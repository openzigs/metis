/**
 * RBAC middleware allow/deny tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { AuthPayload } from "@metis/shared";
import { requireRole } from "../src/middleware/require-role.js";
import { requirePermission } from "../src/middleware/require-permission.js";
import { AppError } from "../src/middleware/error-handler.js";

function makeReq(user?: AuthPayload): Request {
  return { user } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

describe("requireRole", () => {
  it("rejects unauthenticated requests with 401", () => {
    const next: NextFunction = vi.fn();
    requireRole("developer")(makeReq(undefined), makeRes(), next);
    const err = (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(401);
  });

  it("allows admin into any role-gated route", () => {
    const next: NextFunction = vi.fn();
    requireRole("developer")(
      makeReq({ userId: "u", username: "a", role: "admin", permissions: [] }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects reader from coordinator-gated routes with 403", () => {
    const next: NextFunction = vi.fn();
    requireRole("coordinator")(
      makeReq({ userId: "u", username: "a", role: "reader", permissions: [] }),
      makeRes(),
      next,
    );
    const err = (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
  });
});

describe("requirePermission", () => {
  it("rejects unauthenticated requests with 401", () => {
    const next: NextFunction = vi.fn();
    requirePermission("project.create")(makeReq(undefined), makeRes(), next);
    const err = (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(401);
  });

  it("allows admin (carries every permission)", () => {
    const next: NextFunction = vi.fn();
    requirePermission("user.manage")(
      makeReq({ userId: "u", username: "a", role: "admin", permissions: [] }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects reader from any *.write permission", () => {
    const next: NextFunction = vi.fn();
    requirePermission("vault.write")(
      makeReq({ userId: "u", username: "a", role: "reader", permissions: [] }),
      makeRes(),
      next,
    );
    const err = (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
  });

  it("allows developer to read vault but not write", () => {
    const allow: NextFunction = vi.fn();
    requirePermission("vault.read")(
      makeReq({ userId: "u", username: "d", role: "developer", permissions: [] }),
      makeRes(),
      allow,
    );
    expect(allow).toHaveBeenCalledWith();

    const deny: NextFunction = vi.fn();
    requirePermission("vault.write")(
      makeReq({ userId: "u", username: "d", role: "developer", permissions: [] }),
      makeRes(),
      deny,
    );
    const err = (deny as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
  });
});
