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
  notification: { create: vi.fn() },
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

const { fanOutMentions, commentExcerpt } = await import("../src/lib/collaboration/mentions.js");

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
});
