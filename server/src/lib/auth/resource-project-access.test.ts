/**
 * #334 — unit edges of `assertResourceProjectAccess` that the route-level
 * SQLite proofs (tests/project-access-334*.sqlite.test.ts) cannot reach: a
 * missing `req.user`, and a non-404 failure from the project check, which must
 * propagate unchanged rather than be disguised as "not found".
 */
import { describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../custom-agents/authz.js", () => ({ assertProjectAccess }));

const { assertResourceProjectAccess } = await import("./resource-project-access.js");
const { AppError } = await import("../../middleware/error-handler.js");

const member = {
  userId: "u",
  username: "u",
  role: "coordinator",
  permissions: [],
  workspaces: ["ws"],
} as unknown as AuthPayload;
const notFound = () => new AppError(404, "THING_NOT_FOUND", "Thing not found");

describe("assertResourceProjectAccess", () => {
  it("refuses an unauthenticated caller with 401", async () => {
    await expect(assertResourceProjectAccess(undefined, "p", notFound)).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_REQUIRED",
    });
  });

  it("propagates a non-404 failure unchanged", async () => {
    const boom = new Error("database unavailable");
    assertProjectAccess.mockRejectedValueOnce(boom);
    await expect(assertResourceProjectAccess(member, "p", notFound)).rejects.toBe(boom);
  });

  it("remaps the project check's 404 onto the route's own not-found", async () => {
    assertProjectAccess.mockRejectedValueOnce(new AppError(404, "NOT_FOUND", "Project not found"));
    await expect(assertResourceProjectAccess(member, "p", notFound)).rejects.toMatchObject({
      statusCode: 404,
      code: "THING_NOT_FOUND",
    });
  });
});
