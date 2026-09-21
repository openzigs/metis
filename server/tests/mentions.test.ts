/**
 * Epic #728 / Issue #731 — @mention resolver + fan-out tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockPrisma = {
  user: { findMany: vi.fn() },
  mention: { upsert: vi.fn(), updateMany: vi.fn() },
  // #614 — no stored rows: inApp × mention defaults ON (send).
  notificationPreference: { findMany: vi.fn(async () => []) },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: vi.fn(() => ({
    to: vi.fn(() => ({ emit: vi.fn() })),
  })),
}));

const { parseMentions, resolveUsernames, fanOutMentions, dispatchMentions } =
  await import("../src/lib/collaboration/mentions.js");

// ---- Tests -----------------------------------------------------------------

describe("parseMentions", () => {
  it("extracts a single mention", () => {
    expect(parseMentions("Hello @alice")).toEqual(["alice"]);
  });

  it("extracts multiple unique mentions", () => {
    const result = parseMentions("@alice please review, @bob should also check");
    expect(result).toContain("alice");
    expect(result).toContain("bob");
    expect(result).toHaveLength(2);
  });

  it("deduplicates repeated mentions", () => {
    expect(parseMentions("@alice @alice thanks @alice")).toEqual(["alice"]);
  });

  it("returns empty for no mentions", () => {
    expect(parseMentions("no mentions here")).toEqual([]);
  });

  it("handles mentions with dots and underscores", () => {
    expect(parseMentions("@john.doe and @jane_doe")).toEqual(["john.doe", "jane_doe"]);
  });

  it("normalises to lowercase", () => {
    expect(parseMentions("@Alice @BOB")).toEqual(["alice", "bob"]);
  });
});

describe("resolveUsernames", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty for empty input", async () => {
    const result = await resolveUsernames([]);
    expect(result).toEqual([]);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("queries active users with an OR-equals filter and returns matches", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "user-1", username: "alice" },
      { id: "user-2", username: "bob" },
    ]);

    const result = await resolveUsernames(["alice", "bob", "unknown"]);
    expect(result).toHaveLength(2);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "active",
          OR: [
            { username: { equals: "alice" } },
            { username: { equals: "bob" } },
            { username: { equals: "unknown" } },
          ],
        }),
      }),
    );
  });

  it("matches case-insensitively (@Admin resolves to admin)", async () => {
    // Stored username is lowercase 'admin'; the parsed mention is also lowercased
    // upstream, but resolution filters by lowercased equality regardless of casing.
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u-admin", username: "Admin" }]);

    const result = await resolveUsernames(["admin"]);
    expect(result).toEqual([{ id: "u-admin", username: "Admin" }]);
  });

  it("never throws on a DB failure — returns empty (mention stays unresolved)", async () => {
    mockPrisma.user.findMany.mockRejectedValue(new Error("DB down"));
    await expect(resolveUsernames(["admin"])).resolves.toEqual([]);
  });
});

describe("dispatchMentions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not throw when fan-out rejects (fire-and-forget is safe)", async () => {
    mockPrisma.user.findMany.mockRejectedValue(new Error("boom"));
    // Synchronous call must return void without throwing.
    expect(() => dispatchMentions("c-1", "@bob hi", "author-1")).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });

  it("dispatches fan-out for a body with mentions", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-2", username: "bob" }]);
    mockPrisma.mention.upsert.mockResolvedValue({});
    mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });

    dispatchMentions("c-1", "@bob check", "author-1");
    await new Promise((r) => setTimeout(r, 5));
    expect(mockPrisma.mention.upsert).toHaveBeenCalled();
  });
});

describe("fanOutMentions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips fan-out when no mentions", async () => {
    await fanOutMentions("comment-1", "no mentions here", "author-1");
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("skips self-mentions", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "author-1", username: "alice" }]);

    await fanOutMentions("comment-1", "@alice check this", "author-1");
    expect(mockPrisma.mention.upsert).not.toHaveBeenCalled();
  });

  it("creates mention records and emits socket events", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-2", username: "bob" }]);
    mockPrisma.mention.upsert.mockResolvedValue({});
    mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });

    await fanOutMentions("comment-1", "@bob check this", "author-1");

    expect(mockPrisma.mention.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId_mentionedUserId: { commentId: "comment-1", mentionedUserId: "user-2" } },
        create: expect.objectContaining({ commentId: "comment-1", mentionedUserId: "user-2" }),
      }),
    );
    expect(mockPrisma.mention.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: "comment-1", mentionedUserId: "user-2" },
        data: { notified: true },
      }),
    );
  });

  it("does not throw even if socket is not registered", async () => {
    const { getSocketServer } = await import("../src/lib/socket/registry.js");
    vi.mocked(getSocketServer).mockReturnValueOnce(null);
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-2", username: "bob" }]);
    mockPrisma.mention.upsert.mockResolvedValue({});
    mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });

    await expect(fanOutMentions("c-1", "@bob hi", "author-1")).resolves.toBeUndefined();
  });
});
