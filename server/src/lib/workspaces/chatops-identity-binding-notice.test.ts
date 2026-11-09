/**
 * #2089 — the binding notice's wording when the people or workspace it names
 * cannot be read. The recipients and the audit entry are covered through the
 * route (`routes/integrations/teams-link.test.ts`) and read back through the
 * notification list (`tests/chat-identity-binding-notice-2089.sqlite.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspaceMember: { findFirst: vi.fn() },
  workspace: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  notification: { create: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../audit/audit-service.js", () => ({ audit: auditMock }));

import { recordChatIdentityBinding } from "./chatops-identity-binding-notice.js";

describe("recordChatIdentityBinding — fallbacks (#2089)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspaceMember.findFirst.mockResolvedValue({ userId: "u-owner" });
    db.notification.create.mockResolvedValue({ id: "n-1" });
  });

  it("names nobody it cannot read: no actor, no workspace row, no user rows", async () => {
    db.workspace.findUnique.mockResolvedValue(null);
    db.user.findMany.mockResolvedValue([]);
    await recordChatIdentityBinding({
      actorId: null,
      workspaceId: "ws-1",
      provider: "slack",
      boundUserId: "u-bob",
      externalScope: "T1",
      externalId: "U1",
    });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["u-bob"] } } }),
    );
    const byUser = Object.fromEntries(
      db.notification.create.mock.calls.map(([a]) => [a.data.userId, a.data]),
    );
    expect(Object.keys(byUser).sort()).toEqual(["u-bob", "u-owner"]);
    expect(byUser["u-owner"].title).toBe("A Slack account can now act as A workspace admin");
    expect(byUser["u-bob"].message).toBe(
      "A workspace admin linked Slack account U1 to you in a workspace. Chat commands from " +
        "that account now run with your permissions in this workspace.",
    );
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actor: null }));
  });

  it("falls back to the username when a display name is empty", async () => {
    db.workspace.findUnique.mockResolvedValue({ name: "Acme" });
    db.user.findMany.mockResolvedValue([
      { id: "u-admin", displayName: "", username: "adam" },
      { id: "u-bob", displayName: "Bob", username: "bob" },
    ]);
    await recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-bob",
      externalScope: "tenant-a",
      externalId: "aad-1",
    });
    const toBob = db.notification.create.mock.calls.find(([a]) => a.data.userId === "u-bob");
    expect(toBob?.[0].data.message).toMatch(/^adam linked Microsoft Teams account aad-1 to you/);
  });
});
