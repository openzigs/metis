/**
 * #1318 — the live `comment:mention` event carries what the saved notification
 * carries: its id, title (who mentioned you, and where), message (an excerpt of
 * the comment) and link to the comment's thread. It used to send only
 * `{ commentId, mentionedUserId, ts }`, so the drawer showed a raw id and
 * linked to `/comments/<id>`, which has no page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmit = vi.fn();
const mockIoTo = vi.fn(() => ({ emit: mockEmit }));

const mockPrisma = {
  user: { findMany: vi.fn() },
  mention: { upsert: vi.fn(), updateMany: vi.fn() },
  notification: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  notificationPreference: { findMany: vi.fn() },
  comment: { findUnique: vi.fn() },
  userRole: { findFirst: vi.fn() },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: () => ({ to: mockIoTo }),
}));
const canAccessProjectDiscussions = vi.fn();
vi.mock("../src/lib/discussions/access.js", () => ({
  canAccessProjectDiscussions: (...a: unknown[]) => canAccessProjectDiscussions(...a),
}));

const {
  fanOutMentions,
  commentExcerpt,
  refreshCommentMentionExcerpts,
  retractCommentMentionExcerpts,
  DELETED_COMMENT_MESSAGE,
  EDITED_COMMENT_MESSAGE,
} = await import("../src/lib/collaboration/mentions.js");

function onRequirement(title = "Login lockout") {
  mockPrisma.comment.findUnique.mockResolvedValue({
    author: { displayName: "Alex", username: "alex" },
    thread: {
      specKitProjectId: null,
      specKitArtifactName: null,
      requirement: { id: "req-1", title, projectId: "p-1", analysisId: "a-1" },
    },
  });
}

function onArtifact() {
  mockPrisma.comment.findUnique.mockResolvedValue({
    author: { displayName: null, username: "alex" },
    thread: { specKitProjectId: "p-2", specKitArtifactName: "plan.md", requirement: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  onRequirement();
  mockPrisma.user.findMany.mockResolvedValue([{ id: "user-bob", username: "bob" }]);
  mockPrisma.mention.upsert.mockResolvedValue({});
  mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.notification.create.mockResolvedValue({ id: "n-42" });
  mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
  mockPrisma.userRole.findFirst.mockResolvedValue(null);
  canAccessProjectDiscussions.mockResolvedValue(true);
});

describe("comment:mention live payload (#1318)", () => {
  it("emits the saved notification's id, title, message and link", async () => {
    await fanOutMentions("c-1", "@bob can you check the lockout threshold?", "author-1");

    expect(mockIoTo).toHaveBeenCalledWith("user:user-bob");
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [event, payload] = mockEmit.mock.calls[0];
    expect(event).toBe("comment:mention");
    expect(payload).toEqual({
      kind: "mention",
      commentId: "c-1",
      mentionedUserId: "user-bob",
      ts: expect.any(Number),
      notificationId: "n-42",
      title: 'Alex mentioned you on "Login lockout"',
      message: "“@bob can you check the lockout threshold?”",
      href: "/projects/p-1/analysis?analysisId=a-1&requirementId=req-1&comments=1",
    });
  });

  it("the live event and the saved row show the same text and link", async () => {
    await fanOutMentions("c-1", "@bob look", "author-1");

    const saved = mockPrisma.notification.create.mock.calls[0][0].data;
    const live = mockEmit.mock.calls[0][1];
    expect(saved.type).toBe("mention");
    expect({ title: saved.title, message: saved.message, href: saved.href }).toEqual({
      title: live.title,
      message: live.message,
      href: live.href,
    });
  });

  it("persists before it emits, so the event can carry the row id", async () => {
    const order: string[] = [];
    mockPrisma.notification.create.mockImplementation(async () => {
      order.push("persist");
      return { id: "n-1" };
    });
    mockEmit.mockImplementation(() => order.push("emit"));

    await fanOutMentions("c-1", "@bob hi", "author-1");

    expect(order).toEqual(["persist", "emit"]);
  });

  it("still emits, with a null id, when persisting fails", async () => {
    mockPrisma.notification.create.mockRejectedValue(new Error("db down"));

    await fanOutMentions("c-1", "@bob hi", "author-1");

    expect(mockEmit).toHaveBeenCalledWith(
      "comment:mention",
      expect.objectContaining({
        notificationId: null,
        title: 'Alex mentioned you on "Login lockout"',
      }),
    );
  });

  it("names a Spec Kit artifact and links to it", async () => {
    onArtifact();

    await fanOutMentions("c-2", "@bob see section 3", "author-1");

    expect(mockEmit.mock.calls[0][1]).toMatchObject({
      title: "alex mentioned you on plan.md",
      message: "“@bob see section 3”",
      href: "/projects/p-2/spec-kit?artifact=plan.md",
    });
  });

  it("sends nothing — no title, no excerpt — to a user who cannot open the project", async () => {
    canAccessProjectDiscussions.mockResolvedValue(false);

    await fanOutMentions("c-1", "@bob secret plans", "author-1");

    expect(canAccessProjectDiscussions).toHaveBeenCalledWith(
      { id: "user-bob", role: "reader" },
      "p-1",
    );
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it("re-checks access when the mention is sent, failing closed on an error", async () => {
    canAccessProjectDiscussions.mockRejectedValue(new Error("db down"));

    await fanOutMentions("c-1", "@bob hi", "author-1");

    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });
});

describe("commentExcerpt (#1318)", () => {
  it("quotes a short body as is, with its whitespace collapsed", () => {
    expect(commentExcerpt("  @bob   please\n\nreview  ")).toBe("“@bob please review”");
  });

  it("shortens a long body with an ellipsis", () => {
    const out = commentExcerpt("word ".repeat(100));
    expect(out.length).toBeLessThanOrEqual(142);
    expect(out.endsWith("…”")).toBe(true);
  });

  it("returns an empty string for a blank body", () => {
    expect(commentExcerpt("   ")).toBe("");
  });

  /** Any UTF-16 surrogate without its partner. */
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("never splits an emoji at the cut (counts characters, not UTF-16 units)", () => {
    const out = commentExcerpt(`${"a".repeat(138)}😀😀 tail`);
    expect(out).toBe(`“${"a".repeat(138)}😀…”`);
    expect(LONE_SURROGATE.test(out)).toBe(false);
  });

  it("keeps a joined emoji sequence whole", () => {
    const family = "👩‍👩‍👧‍👦";
    const out = commentExcerpt(`${"a".repeat(138)}${family}${family} tail`);
    expect(out).toBe(`“${"a".repeat(138)}${family}…”`);
  });

  it("leaves a body of exactly 140 characters uncut", () => {
    const body = `${"a".repeat(139)}😀`;
    expect(commentExcerpt(body)).toBe(`“${body}”`);
  });
});

describe("excerpt retention (#1318)", () => {
  beforeEach(() => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
  });

  it("saves the comment id on the notification", async () => {
    await fanOutMentions("c-1", "@bob hi", "author-1");
    expect(mockPrisma.notification.create.mock.calls[0][0].data.commentId).toBe("c-1");
  });

  it("retract replaces only that comment's mention excerpts", async () => {
    await retractCommentMentionExcerpts("c-1");
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { commentId: "c-1", type: "mention" },
      data: { message: DELETED_COMMENT_MESSAGE },
    });
  });

  it("retract never throws", async () => {
    mockPrisma.notification.updateMany.mockRejectedValue(new Error("db down"));
    await expect(retractCommentMentionExcerpts("c-1")).resolves.toBeUndefined();
  });

  it("refresh re-quotes recipients who can still open the project and neutralises the rest", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([
      { id: "n-bob", userId: "user-bob" },
      { id: "n-eve", userId: "user-eve" },
    ]);
    canAccessProjectDiscussions.mockImplementation(
      async (actor: { id: string }) => actor.id === "user-bob",
    );

    await refreshCommentMentionExcerpts("c-1", "@bob @eve new text");

    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
      where: { commentId: "c-1", type: "mention" },
      select: { id: true, userId: true },
    });
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["n-bob"] } },
      data: { message: "“@bob @eve new text”" },
    });
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["n-eve"] } },
      data: { message: EDITED_COMMENT_MESSAGE },
    });
  });

  it("refresh neutralises everyone when the comment's location cannot be resolved", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: "n-bob", userId: "user-bob" }]);
    mockPrisma.comment.findUnique.mockResolvedValue(null);

    await refreshCommentMentionExcerpts("c-1", "@bob new");

    expect(canAccessProjectDiscussions).not.toHaveBeenCalled();
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["n-bob"] } },
      data: { message: EDITED_COMMENT_MESSAGE },
    });
  });

  it("refresh does nothing when no notification quotes the comment", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    await refreshCommentMentionExcerpts("c-1", "@bob new");
    expect(mockPrisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("refresh never throws", async () => {
    mockPrisma.notification.findMany.mockRejectedValue(new Error("db down"));
    await expect(refreshCommentMentionExcerpts("c-1", "x")).resolves.toBeUndefined();
  });
});
