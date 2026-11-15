/**
 * Epic #475 (Phase 5, #489) — discussion mention-notification fan-out tests.
 *
 * Covers: parse → resolve → member-filter → dedup/spam-guard → Notification
 * persist + socket emit, the self-mention skip, the non-member suppression
 * (OWASP A01 — no notifying/probing non-members), and the never-throw contract.
 *
 * Prisma, the socket registry, and the resolver are mocked so this runs
 * hermetically (the #289 lesson: never touch a real DB in unit tests).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Prisma double ----------------------------------------------------------
const notificationCreate = vi.fn();
const userRoleFindFirst = vi.fn();
const prefFindMany = vi.fn();
const userFindUnique = vi.fn();
const threadFindFirst = vi.fn();
const notificationFindMany = vi.fn();
const notificationUpdateMany = vi.fn();
const messageFindFirst = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    discussionMessage: { findFirst: (...a: unknown[]) => messageFindFirst(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    discussionThread: { findFirst: (...a: unknown[]) => threadFindFirst(...a) },
    notification: {
      create: (...a: unknown[]) => notificationCreate(...a),
      findMany: (...a: unknown[]) => notificationFindMany(...a),
      updateMany: (...a: unknown[]) => notificationUpdateMany(...a),
    },
    userRole: { findFirst: (...a: unknown[]) => userRoleFindFirst(...a) },
    notificationPreference: { findMany: (...a: unknown[]) => prefFindMany(...a) },
  },
}));

// ---- Project-access seam double (#734) --------------------------------------
// Eligibility is the discussions access rule (`canAccessProjectDiscussions`,
// itself the canonical `assertProjectAccess`); its own tests pin that rule.
const canAccessProjectDiscussions = vi.fn();
vi.mock("./access.js", () => ({
  canAccessProjectDiscussions: (...a: unknown[]) => canAccessProjectDiscussions(...a),
}));

// ---- Socket registry double -------------------------------------------------
const emit = vi.fn();
const to = vi.fn(() => ({ emit }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({
  getSocketServer: () => io,
}));

// ---- Resolver double (collaboration/mentions) -------------------------------
// parseMentions stays REAL (pure regex); resolveUsernames is faked so we control
// which usernames map to which user ids without a DB.
const resolveUsernames = vi.fn();
vi.mock("../collaboration/mentions.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    resolveUsernames: (...a: unknown[]) => resolveUsernames(...a),
  };
});

const {
  notifyDiscussionMentions,
  dispatchDiscussionMentions,
  isProjectMember,
  allowMentionNotification,
  loadMentionNotifyConfig,
  __resetMentionNotifyLimiter,
  __setMentionNotifyStore,
  refreshDiscussionMentionExcerpts,
  retractDiscussionMentionExcerpts,
  syncDiscussionMentionQuotes,
  DELETED_MESSAGE_TEXT,
  EDITED_MESSAGE_TEXT,
} = await import("./notify.js");
const { SharedRateLimitStore, InMemoryRateLimitStore } = await import("./rate-limit-store.js");

function baseInput(over: Partial<Parameters<typeof notifyDiscussionMentions>[0]> = {}) {
  return {
    threadId: "t1",
    projectId: "p1",
    messageId: "m1",
    body: "hey @bob look at this",
    authorId: "author",
    ...over,
  };
}

describe("discussion mention notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMentionNotifyLimiter();
    io = { to };
    delete process.env.DISCUSSION_MENTION_NOTIFY_MAX;
    delete process.env.DISCUSSION_MENTION_NOTIFY_WINDOW_MS;
    // Default: everyone mentioned can access the project; nobody is an admin.
    canAccessProjectDiscussions.mockResolvedValue(true);
    userRoleFindFirst.mockResolvedValue(null);
    notificationCreate.mockResolvedValue({ id: "n1" });
    // #614 — default: no stored preference rows (inApp × mention defaults ON).
    prefFindMany.mockResolvedValue([]);
    userFindUnique.mockResolvedValue({ displayName: "Alice Author", username: "alice" });
    // Default: the thread's title is not readable (the #980 wording applies).
    threadFindFirst.mockResolvedValue(null);
    // #2192 — default: the message cannot be re-read, so the fan-out quotes the
    // body it was handed and syncs nothing (a failed read never costs a mention).
    messageFindFirst.mockRejectedValue(new Error("not under test"));
  });

  it("creates a Notification and emits to the mentioned member's user room", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);

    await notifyDiscussionMentions(baseInput());

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    const data = notificationCreate.mock.calls[0][0].data;
    // #1447 — the row records its project, so every read re-checks access.
    expect(data).toMatchObject({ userId: "bob", type: "discussion_mention", projectId: "p1" });
    // #980 — the link opens the thread itself, and the text names the author.
    expect(data.href).toBe("/projects/p1/discussions/t1");
    expect(data.title).toBe("Alice Author mentioned you in a discussion");
    // #1581 — the message quotes what was said.
    expect(data.message).toBe("“hey @bob look at this”");
    expect(userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "author" } }),
    );
    expect(to).toHaveBeenCalledWith("user:bob");
    expect(emit).toHaveBeenCalledWith(
      "discussion:mention",
      expect.objectContaining({ threadId: "t1", messageId: "m1", mentionedUserId: "bob" }),
    );
  });

  it("#1581 — names the thread, read by id AND project, and quotes the message like a requirement mention", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    threadFindFirst.mockResolvedValue({ title: "  Feed refresh\n schedule " });

    await notifyDiscussionMentions(baseInput({ body: "@bob   can you\n\ncheck the default?" }));

    expect(threadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", projectId: "p1", deletedAt: null } }),
    );
    const data = notificationCreate.mock.calls[0][0].data;
    expect(data.title).toBe('Alice Author mentioned you in "Feed refresh schedule"');
    expect(data.message).toBe("“@bob can you check the default?”");
    expect(emit.mock.calls[0][1]).toMatchObject({ title: data.title, message: data.message });
  });

  it("#1581 — a long thread title is cut, and a failed title read keeps the notification", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    threadFindFirst.mockResolvedValueOnce({ title: "x".repeat(300) });
    await notifyDiscussionMentions(baseInput());
    const title = String(notificationCreate.mock.calls[0][0].data.title);
    expect(title).toBe(`Alice Author mentioned you in "${"x".repeat(119)}…"`);

    __resetMentionNotifyLimiter();
    threadFindFirst.mockRejectedValueOnce(new Error("db down"));
    await notifyDiscussionMentions(baseInput());
    expect(notificationCreate.mock.calls[1][0].data.title).toBe(
      "Alice Author mentioned you in a discussion",
    );
  });

  it("#980 — falls back to the username, then to 'Someone', when the author has no display name", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    userFindUnique.mockResolvedValueOnce({ displayName: "", username: "alice" });
    await notifyDiscussionMentions(baseInput());
    expect(notificationCreate.mock.calls[0][0].data.title).toBe(
      "alice mentioned you in a discussion",
    );
    __resetMentionNotifyLimiter();
    userFindUnique.mockRejectedValueOnce(new Error("db down"));
    await notifyDiscussionMentions(baseInput());
    expect(notificationCreate.mock.calls[1][0].data.title).toBe(
      "Someone mentioned you in a discussion",
    );
  });

  it("skips a self-mention (author never notifies themselves)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "author", username: "author" }]);
    await notifyDiscussionMentions(baseInput({ body: "note to self @author" }));
    expect(notificationCreate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does NOT notify a non-member (OWASP A01 — no spam/probe of outsiders)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "outsider", username: "outsider" }]);
    canAccessProjectDiscussions.mockResolvedValue(false);

    await notifyDiscussionMentions(baseInput({ body: "hey @outsider" }));

    expect(notificationCreate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("#734 — notifies a project member who did not create the project", async () => {
    resolveUsernames.mockResolvedValue([{ id: "developer", username: "developer" }]);

    await notifyDiscussionMentions(baseInput({ body: "@developer can you check?" }));

    expect(canAccessProjectDiscussions).toHaveBeenCalledWith(
      { id: "developer", role: "reader" },
      "p1",
    );
    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("notifies an admin mentioned user even if not the project creator", async () => {
    resolveUsernames.mockResolvedValue([{ id: "adminUser", username: "adminuser" }]);
    userRoleFindFirst.mockResolvedValue({ userId: "adminUser" }); // has admin role
    canAccessProjectDiscussions.mockImplementation(
      async (a: { role: string }) => a.role === "admin",
    );

    await notifyDiscussionMentions(baseInput({ body: "hey @adminuser" }));

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("returns early with no work when there are no mentions", async () => {
    await notifyDiscussionMentions(baseInput({ body: "no mentions here" }));
    expect(resolveUsernames).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it("dedup/spam-guards repeated mentions of the same user in one thread", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    process.env.DISCUSSION_MENTION_NOTIFY_MAX = "2";

    await notifyDiscussionMentions(baseInput());
    await notifyDiscussionMentions(baseInput({ messageId: "m2" }));
    await notifyDiscussionMentions(baseInput({ messageId: "m3" })); // over the limit

    expect(notificationCreate).toHaveBeenCalledTimes(2);
  });

  it("dedups within a single message body (one notification per user)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    // parseMentions dedups @bob @bob → one username → one resolved user → one notify.
    await notifyDiscussionMentions(baseInput({ body: "@bob @bob @bob ping" }));
    expect(notificationCreate).toHaveBeenCalledTimes(1);
  });

  it("suppresses the notification when the user disabled inApp × mention (#614)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    prefFindMany.mockResolvedValue([{ channel: "inApp", event: "mention", enabled: false }]);

    await notifyDiscussionMentions(baseInput());

    expect(notificationCreate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("sends when the user has an explicit enabled inApp × mention row (#614)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    prefFindMany.mockResolvedValue([{ channel: "inApp", event: "mention", enabled: true }]);

    await notifyDiscussionMentions(baseInput());

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("FAILS OPEN and still sends when the preference lookup throws (#614)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    prefFindMany.mockRejectedValue(new Error("preference db down"));

    await notifyDiscussionMentions(baseInput());

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("a preference-suppressed mention does NOT consume the spam-guard window (#614)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    process.env.DISCUSSION_MENTION_NOTIFY_MAX = "1";
    prefFindMany.mockResolvedValueOnce([{ channel: "inApp", event: "mention", enabled: false }]);

    await notifyDiscussionMentions(baseInput()); // suppressed — window untouched
    await notifyDiscussionMentions(baseInput({ messageId: "m2" })); // re-enabled → sends

    expect(notificationCreate).toHaveBeenCalledTimes(1);
  });

  it("still emits even if the Notification persist fails (best-effort)", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    notificationCreate.mockRejectedValue(new Error("db down"));
    await notifyDiscussionMentions(baseInput());
    expect(emit).toHaveBeenCalledTimes(1);
    // #104 — no row, so no id to merge on; the text and link still ride along.
    expect(emit.mock.calls[0][1]).toMatchObject({
      notificationId: null,
      title: "Alice Author mentioned you in a discussion",
      href: "/projects/p1/discussions/t1",
    });
  });

  it("#104 — emits the persisted row's id, title, message and link for the drawer", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    notificationCreate.mockResolvedValue({ id: "notif-42" });

    await notifyDiscussionMentions(baseInput());

    const data = notificationCreate.mock.calls[0][0].data;
    expect(emit).toHaveBeenCalledWith("discussion:mention", {
      kind: "discussion_mention",
      threadId: "t1",
      messageId: "m1",
      mentionedUserId: "bob",
      ts: expect.any(Number),
      notificationId: "notif-42",
      title: data.title,
      message: data.message,
      href: data.href,
    });
  });

  it("is a no-op (no throw) when no socket server is registered", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
    io = null;
    await expect(notifyDiscussionMentions(baseInput())).resolves.toBeUndefined();
    expect(notificationCreate).toHaveBeenCalledTimes(1); // still persists
    expect(emit).not.toHaveBeenCalled();
  });

  it("never throws when resolveUsernames itself rejects", async () => {
    resolveUsernames.mockRejectedValue(new Error("resolve boom"));
    await expect(notifyDiscussionMentions(baseInput())).resolves.toBeUndefined();
  });

  describe("isProjectMember", () => {
    it("asks the project-access rule, as an admin when the user holds the admin role", async () => {
      userRoleFindFirst.mockResolvedValue({ userId: "adm" });
      expect(await isProjectMember("adm", "p1")).toBe(true);
      expect(userRoleFindFirst).toHaveBeenCalledWith({
        where: { userId: "adm", role: { key: "admin" } },
        select: { userId: true },
      });
      expect(canAccessProjectDiscussions).toHaveBeenCalledWith({ id: "adm", role: "admin" }, "p1");
    });
    it("asks as a non-admin otherwise, without an audit context", async () => {
      expect(await isProjectMember("dev", "p1")).toBe(true);
      expect(canAccessProjectDiscussions).toHaveBeenCalledWith({ id: "dev", role: "reader" }, "p1");
    });
    it("returns false when the rule denies", async () => {
      canAccessProjectDiscussions.mockResolvedValue(false);
      expect(await isProjectMember("nope", "p1")).toBe(false);
    });
    it("returns false (fails closed) when the role lookup throws", async () => {
      userRoleFindFirst.mockRejectedValue(new Error("db boom"));
      expect(await isProjectMember("x", "p1")).toBe(false);
    });
    it("returns false (fails closed) when the access check throws", async () => {
      canAccessProjectDiscussions.mockRejectedValue(new Error("db boom"));
      expect(await isProjectMember("x", "p1")).toBe(false);
    });
  });

  describe("allowMentionNotification", () => {
    it("allows up to max then blocks within the window", async () => {
      const cfg = { max: 2, windowMs: 60_000 };
      expect(await allowMentionNotification("t", "u", cfg)).toBe(true);
      expect(await allowMentionNotification("t", "u", cfg)).toBe(true);
      expect(await allowMentionNotification("t", "u", cfg)).toBe(false);
    });
    it("keys independently per (thread,user)", async () => {
      const cfg = { max: 1, windowMs: 60_000 };
      expect(await allowMentionNotification("t1", "u", cfg)).toBe(true);
      expect(await allowMentionNotification("t2", "u", cfg)).toBe(true);
      expect(await allowMentionNotification("t1", "u2", cfg)).toBe(true);
      expect(await allowMentionNotification("t1", "u", cfg)).toBe(false);
    });

    it("enforces the spam cap GLOBALLY across two replicas sharing one store (#508)", async () => {
      // Simulate two replicas: both notify call sites resolve the SAME shared
      // store, the shared-store deployment topology. Injecting one shared
      // instance makes the per-(thread,user) cap hold cluster-wide rather than
      // scaling with replica count (the residual risk #508 closes).
      const shared = new SharedRateLimitStore();
      const prev = __setMentionNotifyStore(shared);
      try {
        const cfg = { max: 2, windowMs: 60_000 };
        // Two notifications (e.g. one from each replica) saturate the GLOBAL window.
        expect(await allowMentionNotification("t", "victim", cfg)).toBe(true);
        expect(await allowMentionNotification("t", "victim", cfg)).toBe(true);
        // The third — regardless of which replica fields it — is blocked because
        // all replicas share ONE window.
        expect(await allowMentionNotification("t", "victim", cfg)).toBe(false);
      } finally {
        __setMentionNotifyStore(prev);
      }
    });

    it("two SEPARATE in-memory stores do NOT share — per-process limit is real (#508)", async () => {
      const replicaA = new InMemoryRateLimitStore();
      const replicaB = new InMemoryRateLimitStore();
      const now = Date.now();
      // Each replica independently allows up to max, so the effective spam
      // ceiling is 2× — exactly what the shared backend removes.
      expect((await replicaA.hit("t::victim", 2, 60_000, now)).allowed).toBe(true);
      expect((await replicaA.hit("t::victim", 2, 60_000, now)).allowed).toBe(true);
      expect((await replicaA.hit("t::victim", 2, 60_000, now)).allowed).toBe(false);
      expect((await replicaB.hit("t::victim", 2, 60_000, now)).allowed).toBe(true);
      expect((await replicaB.hit("t::victim", 2, 60_000, now)).allowed).toBe(true);
    });
  });

  describe("loadMentionNotifyConfig", () => {
    it("returns defaults when env is unset", () => {
      expect(loadMentionNotifyConfig({})).toEqual({ max: 5, windowMs: 60_000 });
    });
    it("honours env overrides", () => {
      expect(
        loadMentionNotifyConfig({
          DISCUSSION_MENTION_NOTIFY_MAX: "9",
          DISCUSSION_MENTION_NOTIFY_WINDOW_MS: "5000",
        }),
      ).toEqual({ max: 9, windowMs: 5000 });
    });
    it("ignores invalid env and uses defaults", () => {
      expect(
        loadMentionNotifyConfig({
          DISCUSSION_MENTION_NOTIFY_MAX: "abc",
          DISCUSSION_MENTION_NOTIFY_WINDOW_MS: "0",
        }),
      ).toEqual({ max: 5, windowMs: 60_000 });
    });
  });

  describe("dispatchDiscussionMentions", () => {
    it("is fire-and-forget and never throws synchronously", () => {
      resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
      expect(() => dispatchDiscussionMentions(baseInput())).not.toThrow();
    });
  });

  describe("#2192 — an edit's added mention", () => {
    it("notifies only the handles named, and quotes the whole message", async () => {
      resolveUsernames.mockResolvedValue([{ id: "carol", username: "carol" }]);

      await notifyDiscussionMentions(
        baseInput({ body: "hi @bob, and now @carol too", mentions: ["carol"] }),
      );

      expect(resolveUsernames).toHaveBeenCalledWith(["carol"]);
      expect(notificationCreate).toHaveBeenCalledTimes(1);
      expect(notificationCreate.mock.calls[0][0].data.message).toBe(
        "“hi @bob, and now @carol too”",
      );
    });

    it("an empty handle list notifies nobody", async () => {
      await notifyDiscussionMentions(baseInput({ mentions: [] }));
      expect(resolveUsernames).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });
  });

  describe("#2192 — a fan-out that an edit or delete overtook", () => {
    const live = (body: string) => ({ body, deletedAt: null });
    const quoting = [
      {
        id: "n1",
        userId: "bob",
        payload: JSON.stringify({ kind: "discussion_mention", messageId: "m1" }),
      },
    ];
    beforeEach(() => {
      resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);
      notificationFindMany.mockResolvedValue(quoting);
    });

    it("quotes the message as it reads now, not as it was posted", async () => {
      messageFindFirst.mockResolvedValue(live("@bob edited already"));

      await notifyDiscussionMentions(baseInput({ body: "@bob as posted" }));

      expect(messageFindFirst).toHaveBeenCalledWith({
        where: { id: "m1", threadId: "t1" },
        select: { body: true, deletedAt: true },
      });
      expect(notificationCreate.mock.calls[0][0].data.message).toBe("“@bob edited already”");
      // Read twice, the same both times: nothing to re-sync.
      expect(notificationUpdateMany).not.toHaveBeenCalled();
    });

    it("notifies nobody about a message deleted before the fan-out ran", async () => {
      messageFindFirst.mockResolvedValue({ body: "@bob", deletedAt: new Date() });
      await notifyDiscussionMentions(baseInput());
      expect(notificationCreate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it("an edit that lands while its row is written re-quotes that row", async () => {
      messageFindFirst
        .mockResolvedValueOnce(live("@bob as posted"))
        .mockResolvedValue(live("@bob after the edit"));

      await notifyDiscussionMentions(baseInput({ body: "@bob as posted" }));

      expect(notificationCreate.mock.calls[0][0].data.message).toBe("“@bob as posted”");
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1"] } },
        data: { message: "“@bob after the edit”" },
      });
    });

    it("a delete that lands while its row is written retracts that row's quote", async () => {
      messageFindFirst
        .mockResolvedValueOnce(live("@bob as posted"))
        .mockResolvedValue({ body: "@bob as posted", deletedAt: new Date() });

      await notifyDiscussionMentions(baseInput({ body: "@bob as posted" }));

      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1"] } },
        data: { message: DELETED_MESSAGE_TEXT },
      });
    });
  });

  describe("#2192 — syncDiscussionMentionQuotes", () => {
    const target = { threadId: "t1", projectId: "p1", messageId: "m1" };
    beforeEach(() => {
      notificationFindMany.mockResolvedValue([
        {
          id: "n1",
          userId: "bob",
          payload: JSON.stringify({ kind: "discussion_mention", messageId: "m1" }),
        },
      ]);
    });

    it("writes what the message says when read, and stops once a re-read agrees", async () => {
      messageFindFirst.mockResolvedValue({ body: "@bob latest", deletedAt: null });
      await syncDiscussionMentionQuotes(target);
      expect(messageFindFirst).toHaveBeenCalledTimes(2);
      expect(notificationUpdateMany).toHaveBeenCalledTimes(1);
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1"] } },
        data: { message: "“@bob latest”" },
      });
    });

    it("rewrites when the message changed between its write and its re-read", async () => {
      messageFindFirst
        .mockResolvedValueOnce({ body: "@bob first", deletedAt: null })
        .mockResolvedValue({ body: "@bob second", deletedAt: null });
      await syncDiscussionMentionQuotes(target);
      expect(notificationUpdateMany.mock.calls.map((c) => c[0].data.message)).toEqual([
        "“@bob first”",
        "“@bob second”",
      ]);
    });

    it("retracts a deleted message, and stops after a bounded number of writes", async () => {
      let n = 0;
      messageFindFirst.mockImplementation(async () =>
        ++n % 2 ? { body: "@bob", deletedAt: new Date() } : { body: `@bob v${n}`, deletedAt: null },
      );
      await syncDiscussionMentionQuotes(target);
      expect(notificationUpdateMany).toHaveBeenCalledTimes(3);
      expect(notificationUpdateMany.mock.calls[0][0].data.message).toBe(DELETED_MESSAGE_TEXT);
    });

    it("never throws when the message cannot be read", async () => {
      messageFindFirst.mockRejectedValue(new Error("db down"));
      await expect(syncDiscussionMentionQuotes(target)).resolves.toBeUndefined();
      expect(notificationUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("#2192 — quotes of an edited or deleted message", () => {
    const row = (id: string, userId: string, messageId = "m1") => ({
      id,
      userId,
      payload: JSON.stringify({ kind: "discussion_mention", threadId: "t1", messageId }),
    });

    it("finds the message's notifications by type, project and payload", async () => {
      notificationFindMany.mockResolvedValue([]);
      await retractDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1" });
      expect(notificationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            type: "discussion_mention",
            projectId: "p1",
            payload: { contains: '"messageId":"m1"' },
          },
        }),
      );
      // Nothing quoted the message: nothing is written.
      expect(notificationUpdateMany).not.toHaveBeenCalled();
    });

    it("a delete replaces the quote, and only on rows whose payload names that message", async () => {
      notificationFindMany.mockResolvedValue([
        row("n1", "bob"),
        // The substring match only narrows: whatever the database returns, a
        // row whose parsed payload names another message is left alone.
        row("n2", "carol", "m1x"),
        { id: "n3", userId: "dave", payload: "not json" },
        { id: "n4", userId: "erin", payload: null },
      ]);

      await retractDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1" });

      expect(notificationUpdateMany).toHaveBeenCalledTimes(1);
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1"] } },
        data: { message: DELETED_MESSAGE_TEXT },
      });
    });

    it("a delete never throws when the database fails", async () => {
      notificationFindMany.mockRejectedValue(new Error("db down"));
      await expect(
        retractDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1" }),
      ).resolves.toBeUndefined();
    });

    it("an edit re-quotes a member's notification with the new text", async () => {
      notificationFindMany.mockResolvedValue([row("n1", "bob"), row("n2", "bob")]);

      await refreshDiscussionMentionExcerpts({
        projectId: "p1",
        messageId: "m1",
        body: "@bob  the new\n text",
      });

      expect(canAccessProjectDiscussions).toHaveBeenCalledTimes(1); // once per user
      expect(notificationUpdateMany).toHaveBeenCalledTimes(1);
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1", "n2"] } },
        data: { message: "“@bob the new text”" },
      });
    });

    it("an edit does not show the new text to a recipient who lost access", async () => {
      notificationFindMany.mockResolvedValue([row("n1", "bob"), row("n2", "carol")]);
      canAccessProjectDiscussions.mockImplementation(async (u: { id: string }) => u.id === "bob");

      await refreshDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1", body: "secret" });

      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1"] } },
        data: { message: "“secret”" },
      });
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n2"] } },
        data: { message: EDITED_MESSAGE_TEXT },
      });
    });

    it("an edit to a blank body leaves the neutral text, checking nobody's access", async () => {
      notificationFindMany.mockResolvedValue([row("n1", "bob")]);

      await refreshDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1", body: "  " });

      expect(canAccessProjectDiscussions).not.toHaveBeenCalled();
      expect(notificationUpdateMany).toHaveBeenCalledTimes(1);
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["n1"] } },
        data: { message: EDITED_MESSAGE_TEXT },
      });
    });

    it("an edit with no quoting notification writes nothing, and never throws on failure", async () => {
      notificationFindMany.mockResolvedValueOnce([]);
      await refreshDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1", body: "x" });
      expect(notificationUpdateMany).not.toHaveBeenCalled();

      notificationFindMany.mockRejectedValueOnce(new Error("db down"));
      await expect(
        refreshDiscussionMentionExcerpts({ projectId: "p1", messageId: "m1", body: "x" }),
      ).resolves.toBeUndefined();
    });
  });
});
