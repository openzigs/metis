/**
 * Issue #416 — fanOutMentions persistence tests.
 *
 * Verifies that a Notification row is persisted for each mentioned user
 * alongside the socket emit, and that persistence failures do NOT break the emit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmit = vi.fn();
const mockIo = { to: vi.fn(() => ({ emit: mockEmit })) };

const mockPrisma = {
  user: { findMany: vi.fn() },
  mention: { upsert: vi.fn(), updateMany: vi.fn() },
  notification: { create: vi.fn() },
  notificationPreference: { findMany: vi.fn() },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: () => mockIo,
}));

const { fanOutMentions } = await import("../src/lib/collaboration/mentions.js");

describe("fanOutMentions — Issue #416 persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.mention.upsert.mockResolvedValue({});
    mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.create.mockResolvedValue({ id: "n-1" });
    // #614 — default: no stored preference rows (inApp × mention defaults ON).
    mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
  });

  it("persists a Notification row for the mentioned user", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-bob", username: "bob" }]);

    await fanOutMentions("comment-1", "@bob check this", "author-1");

    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-bob",
          type: "mention",
          title: expect.stringContaining("mentioned"),
        }),
      }),
    );
  });

  it("persists a Notification with an href linking to the comment", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-carol", username: "carol" }]);

    await fanOutMentions("comment-xyz", "@carol hi", "author-1");

    const createCall = mockPrisma.notification.create.mock.calls[0][0];
    expect(createCall.data.href).toContain("comment-xyz");
  });

  it("still emits the socket event even when persistence fails", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-dave", username: "dave" }]);
    mockPrisma.notification.create.mockRejectedValue(new Error("DB unavailable"));

    // Must NOT throw.
    await expect(fanOutMentions("comment-2", "@dave check", "author-1")).resolves.toBeUndefined();

    // Socket emit must still have fired.
    expect(mockIo.to).toHaveBeenCalledWith("user:user-dave");
    expect(mockEmit).toHaveBeenCalledWith(
      "comment:mention",
      expect.objectContaining({ commentId: "comment-2", mentionedUserId: "user-dave" }),
    );
  });

  it("does NOT persist a notification for self-mentions", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "author-1", username: "alice" }]);

    await fanOutMentions("comment-3", "@alice self", "author-1");

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  describe("preference enforcement (#614 — inApp × mention)", () => {
    it("suppresses the emit + Notification row when the user disabled inApp × mention, but keeps the Mention provenance row un-notified", async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: "user-bob", username: "bob" }]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { channel: "inApp", event: "mention", enabled: false },
      ]);

      await fanOutMentions("comment-4", "@bob check this", "author-1");

      expect(mockEmit).not.toHaveBeenCalled();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      // Mention provenance is still recorded, but NOT marked notified.
      expect(mockPrisma.mention.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mention.updateMany).not.toHaveBeenCalled();
    });

    it("sends when the user has an explicit enabled inApp × mention row", async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: "user-bob", username: "bob" }]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { channel: "inApp", event: "mention", enabled: true },
      ]);

      await fanOutMentions("comment-5", "@bob check this", "author-1");

      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it("FAILS OPEN and still sends when the preference lookup throws", async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: "user-bob", username: "bob" }]);
      mockPrisma.notificationPreference.findMany.mockRejectedValue(new Error("db down"));

      await fanOutMentions("comment-6", "@bob check this", "author-1");

      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });
});
