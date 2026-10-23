/**
 * #1437 — the ChatOps target-scope helpers. Real-database behaviour (W1 vs W2,
 * legacy projects, both chat surfaces) is pinned in
 * `tests/chatops-project-workspace-scope-1437.sqlite.test.ts`; this covers the
 * query shape and the blank-input guards.
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  draftInWorkspaceWhere,
  isProjectInWorkspace,
  isThreadInWorkspace,
} from "./chatops-project-scope.js";

function fakeDb(found: boolean) {
  const project = { findFirst: vi.fn(async () => (found ? { id: "p" } : null)) };
  const discussionThread = { findFirst: vi.fn(async () => (found ? { id: "t" } : null)) };
  return {
    db: { project, discussionThread } as unknown as PrismaClient,
    project,
    discussionThread,
  };
}

describe("isProjectInWorkspace", () => {
  it("matches on the project id AND the workspace id", async () => {
    const f = fakeDb(true);
    expect(await isProjectInWorkspace(f.db, "ws-1", "p-1")).toBe(true);
    expect(f.project.findFirst).toHaveBeenCalledWith({
      where: { id: "p-1", workspaceId: "ws-1" },
      select: { id: true },
    });
  });

  it("is false when no such project is in the workspace", async () => {
    expect(await isProjectInWorkspace(fakeDb(false).db, "ws-1", "p-2")).toBe(false);
  });

  it("fails closed on a blank workspace or project id without querying", async () => {
    const f = fakeDb(true);
    expect(await isProjectInWorkspace(f.db, "", "p-1")).toBe(false);
    expect(await isProjectInWorkspace(f.db, "ws-1", "")).toBe(false);
    expect(f.project.findFirst).not.toHaveBeenCalled();
  });
});

describe("isThreadInWorkspace", () => {
  it("matches a live thread whose project is in the workspace", async () => {
    const f = fakeDb(true);
    expect(await isThreadInWorkspace(f.db, "ws-1", "t-1")).toBe(true);
    expect(f.discussionThread.findFirst).toHaveBeenCalledWith({
      where: { id: "t-1", deletedAt: null, project: { workspaceId: "ws-1" } },
      select: { id: true },
    });
  });

  it("is false for a thread elsewhere, and for blank input without querying", async () => {
    expect(await isThreadInWorkspace(fakeDb(false).db, "ws-1", "t-2")).toBe(false);
    const f = fakeDb(true);
    expect(await isThreadInWorkspace(f.db, "", "t-1")).toBe(false);
    expect(await isThreadInWorkspace(f.db, "ws-1", "")).toBe(false);
    expect(f.discussionThread.findFirst).not.toHaveBeenCalled();
  });
});

describe("draftInWorkspaceWhere", () => {
  it("scopes a live draft to its project's workspace", () => {
    expect(draftInWorkspaceWhere("d-1", "ws-1")).toEqual({
      id: "d-1",
      deletedAt: null,
      project: { workspaceId: "ws-1" },
    });
  });
});
