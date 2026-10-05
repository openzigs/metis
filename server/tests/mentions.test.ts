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
  // #734/#735 — where the comment lives (link, text, audience).
  comment: { findUnique: vi.fn() },
  userRole: { findFirst: vi.fn() },
  notification: { create: vi.fn() },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
const mockEmit = vi.fn();
const mockIoTo = vi.fn(() => ({ emit: mockEmit }));
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: vi.fn(() => ({ to: mockIoTo })),
}));

const canAccessProjectDiscussions = vi.fn();
vi.mock("../src/lib/discussions/access.js", () => ({
  canAccessProjectDiscussions: (...a: unknown[]) => canAccessProjectDiscussions(...a),
}));

/** A comment on requirement `req-1` of project `p-1`, by Alice. */
function requirementComment(title = "Login works") {
  mockPrisma.comment.findUnique.mockResolvedValue({
    author: { displayName: "Alice", username: "alice" },
    thread: {
      specKitProjectId: null,
      specKitArtifactName: null,
      requirement: { id: "req-1", title, projectId: "p-1", analysisId: "a-1" },
    },
  });
}

function resetFanOutDoubles() {
  vi.clearAllMocks();
  requirementComment();
  mockPrisma.userRole.findFirst.mockResolvedValue(null);
  mockPrisma.notification.create.mockResolvedValue({});
  canAccessProjectDiscussions.mockResolvedValue(true);
}

const {
  parseMentions,
  resolveUsernames,
  fanOutMentions,
  dispatchMentions,
  resolveCommentMentionContext,
} = await import("../src/lib/collaboration/mentions.js");

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
  beforeEach(resetFanOutDoubles);

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
  beforeEach(resetFanOutDoubles);

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
    // #686 — the mention reaches the mentioned user's personal room.
    expect(mockIoTo).toHaveBeenCalledWith("user:user-2");
    expect(mockEmit).toHaveBeenCalledWith(
      "comment:mention",
      expect.objectContaining({ commentId: "comment-1", mentionedUserId: "user-2" }),
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

  // ---- #734 — only users who can open the project are notified ------------

  it("skips a mentioned user who cannot open the comment's project (#734)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "user-2", username: "bob" },
      { id: "user-3", username: "eve" },
    ]);
    canAccessProjectDiscussions.mockImplementation(
      async (actor: { id: string }) => actor.id === "user-2",
    );
    mockPrisma.mention.upsert.mockResolvedValue({});
    mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });

    await fanOutMentions("comment-1", "@bob @eve check", "author-1");

    expect(canAccessProjectDiscussions).toHaveBeenCalledWith(
      { id: "user-3", role: "reader" },
      "p-1",
    );
    expect(mockPrisma.mention.upsert).toHaveBeenCalledTimes(1);
    expect(mockIoTo).toHaveBeenCalledWith("user:user-2");
    expect(mockIoTo).not.toHaveBeenCalledWith("user:user-3");
  });

  it("checks a system admin as an admin", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-9", username: "root" }]);
    mockPrisma.userRole.findFirst.mockResolvedValue({ userId: "user-9" });

    await fanOutMentions("comment-1", "@root", "author-1");

    expect(canAccessProjectDiscussions).toHaveBeenCalledWith(
      { id: "user-9", role: "admin" },
      "p-1",
    );
  });

  it("fails closed when the eligibility check errors", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-2", username: "bob" }]);
    canAccessProjectDiscussions.mockRejectedValue(new Error("db down"));

    await fanOutMentions("comment-1", "@bob", "author-1");

    expect(mockPrisma.mention.upsert).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("sends nothing when the comment cannot be resolved to a project", async () => {
    mockPrisma.comment.findUnique.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-2", username: "bob" }]);

    await fanOutMentions("comment-gone", "@bob", "author-1");

    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.mention.upsert).not.toHaveBeenCalled();
  });
});

describe("resolveCommentMentionContext (#735)", () => {
  beforeEach(resetFanOutDoubles);

  it("links a requirement comment to the requirement on the analysis page", async () => {
    await expect(resolveCommentMentionContext("c-1")).resolves.toEqual({
      projectId: "p-1",
      href: "/projects/p-1/analysis?analysisId=a-1&requirementId=req-1",
      message: 'Alice mentioned you on "Login works"',
    });
  });

  it("shortens a long requirement title in the message", async () => {
    requirementComment("x".repeat(300));

    const ctx = await resolveCommentMentionContext("c-1");

    expect(ctx?.message.length).toBeLessThan(160);
    expect(ctx?.message.endsWith('…"')).toBe(true);
  });

  it("links an artifact comment to the Spec Kit artifact", async () => {
    mockPrisma.comment.findUnique.mockResolvedValue({
      author: { displayName: "", username: "alice" },
      thread: { specKitProjectId: "p 1", specKitArtifactName: "plan.md", requirement: null },
    });

    await expect(resolveCommentMentionContext("c-1")).resolves.toEqual({
      projectId: "p 1",
      href: "/projects/p%201/spec-kit?artifact=plan.md",
      message: "alice mentioned you on plan.md",
    });
  });

  it("returns null for a thread anchored to nothing", async () => {
    mockPrisma.comment.findUnique.mockResolvedValue({
      author: null,
      thread: { specKitProjectId: null, specKitArtifactName: null, requirement: null },
    });

    await expect(resolveCommentMentionContext("c-1")).resolves.toBeNull();
  });
});
