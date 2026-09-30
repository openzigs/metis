/**
 * #549 / #612 — the one membership query that authorizes workspace access
 * drops soft-deleted workspaces AND soft-deleted or disabled users. A user can
 * be soft-deleted outside SCIM (which also disables), so both halves of the
 * user filter are pinned here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { workspaceMember: { findMany } } }));

import { readLiveWorkspaceIds } from "./live-workspace-ids.js";

describe("readLiveWorkspaceIds", () => {
  beforeEach(() => findMany.mockReset());

  it("filters on a live workspace and a live, active user", async () => {
    findMany.mockResolvedValue([{ workspaceId: "ws-1" }, { workspaceId: "ws-2" }]);
    await expect(readLiveWorkspaceIds("u-1")).resolves.toEqual(["ws-1", "ws-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "u-1",
        workspace: { deletedAt: null },
        user: { deletedAt: null, status: "active" },
      },
      select: { workspaceId: true },
    });
  });
});
