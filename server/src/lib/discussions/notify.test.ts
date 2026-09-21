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
const projectFindFirst = vi.fn();
const userRoleFindFirst = vi.fn();
const prefFindMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    notification: { create: (...a: unknown[]) => notificationCreate(...a) },
    project: { findFirst: (...a: unknown[]) => projectFindFirst(...a) },
    userRole: { findFirst: (...a: unknown[]) => userRoleFindFirst(...a) },
    notificationPreference: { findMany: (...a: unknown[]) => prefFindMany(...a) },
  },
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
    // Default: bob is the project creator (a member).
    projectFindFirst.mockResolvedValue({ createdById: "bob" });
    userRoleFindFirst.mockResolvedValue(null);
    notificationCreate.mockResolvedValue({ id: "n1" });
    // #614 — default: no stored preference rows (inApp × mention defaults ON).
    prefFindMany.mockResolvedValue([]);
  });

  it("creates a Notification and emits to the mentioned member's user room", async () => {
    resolveUsernames.mockResolvedValue([{ id: "bob", username: "bob" }]);

    await notifyDiscussionMentions(baseInput());

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    const data = notificationCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "bob", type: "discussion_mention" });
    expect(data.href).toContain("/projects/p1/discussions");
    expect(data.href).toContain("thread=t1");
    expect(to).toHaveBeenCalledWith("user:bob");
    expect(emit).toHaveBeenCalledWith(
      "discussion:mention",
      expect.objectContaining({ threadId: "t1", messageId: "m1", mentionedUserId: "bob" }),
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
    projectFindFirst.mockResolvedValue({ createdById: "someone-else" });
    userRoleFindFirst.mockResolvedValue(null); // not an admin

    await notifyDiscussionMentions(baseInput({ body: "hey @outsider" }));

    expect(notificationCreate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("notifies an admin mentioned user even if not the project creator", async () => {
    resolveUsernames.mockResolvedValue([{ id: "adminUser", username: "adminuser" }]);
    projectFindFirst.mockResolvedValue({ createdById: "someone-else" });
    userRoleFindFirst.mockResolvedValue({ userId: "adminUser" }); // has admin role

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
    it("returns true for the project creator", async () => {
      projectFindFirst.mockResolvedValue({ createdById: "bob" });
      expect(await isProjectMember("bob", "p1")).toBe(true);
    });
    it("returns true for an admin who is not the creator", async () => {
      projectFindFirst.mockResolvedValue({ createdById: "other" });
      userRoleFindFirst.mockResolvedValue({ userId: "adm" });
      expect(await isProjectMember("adm", "p1")).toBe(true);
    });
    it("returns false for a non-creator non-admin", async () => {
      projectFindFirst.mockResolvedValue({ createdById: "other" });
      userRoleFindFirst.mockResolvedValue(null);
      expect(await isProjectMember("nope", "p1")).toBe(false);
    });
    it("returns false (fails closed) when the project is missing", async () => {
      projectFindFirst.mockResolvedValue(null);
      expect(await isProjectMember("x", "p1")).toBe(false);
    });
    it("returns false (fails closed) when the lookup throws", async () => {
      projectFindFirst.mockRejectedValue(new Error("db boom"));
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
});
