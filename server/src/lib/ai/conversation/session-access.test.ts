/**
 * #127 — who may reach a chat session. The end-to-end proof (other user, lost
 * project access, forks) is `tests/ai-conversation.sqlite.test.ts`; these pin
 * the helper's edges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());
const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../../prisma.js", () => ({ prisma: { aISession: { findFirst } } }));
vi.mock("../../custom-agents/authz.js", () => ({ assertProjectAccess }));

const { loadAuthorizedSession, SESSION_NOT_FOUND } = await import("./session-access.js");
const { AppError } = await import("../../../middleware/error-handler.js");

const user = { userId: "u1", username: "u", role: "developer" as const, permissions: [] };

beforeEach(() => {
  findFirst.mockReset();
  assertProjectAccess.mockReset();
});

describe("loadAuthorizedSession", () => {
  it("401 without a user", async () => {
    await expect(loadAuthorizedSession(undefined, "s")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("scopes the lookup to the caller and live rows", async () => {
    findFirst.mockResolvedValue(null);
    await expect(loadAuthorizedSession(user, "s")).rejects.toMatchObject({
      statusCode: 404,
      code: SESSION_NOT_FOUND,
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "s", userId: "u1", deletedAt: null } });
  });

  it("an unscoped session needs no project check", async () => {
    findFirst.mockResolvedValue({ id: "s", projectId: null });
    await expect(loadAuthorizedSession(user, "s")).resolves.toMatchObject({ id: "s" });
    expect(assertProjectAccess).not.toHaveBeenCalled();
  });

  it("a project the caller cannot reach answers the same 404 as an unknown session", async () => {
    findFirst.mockResolvedValue({ id: "s", projectId: "p" });
    assertProjectAccess.mockRejectedValue(new AppError(404, "NOT_FOUND", "Project not found"));
    await expect(loadAuthorizedSession(user, "s")).rejects.toMatchObject({
      statusCode: 404,
      code: SESSION_NOT_FOUND,
    });
    expect(assertProjectAccess).toHaveBeenCalledWith(user, "p");
  });

  it("any other failure is not disguised", async () => {
    findFirst.mockResolvedValue({ id: "s", projectId: "p" });
    assertProjectAccess.mockRejectedValue(new Error("db down"));
    await expect(loadAuthorizedSession(user, "s")).rejects.toThrow("db down");
  });
});
