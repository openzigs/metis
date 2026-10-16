/**
 * #734 — editing and deleting a discussion message.
 *
 * The caller has already authorized the actor for the thread (`canAccessThread`).
 * These tests pin what this module adds on top: the message must be a live
 * message of THAT thread, only its human author may change it, the fan-out goes
 * only to the thread room, and an edit notifies only the mentions it added.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteHumanDiscussionMessage,
  editHumanDiscussionMessage,
  MessageChangeError,
} from "./edit-message.js";

const audit = vi.fn();
vi.mock("../audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const EXISTING = {
  id: "m1",
  threadId: "t1",
  authorKind: "human",
  authorUserId: "alice",
  body: "hi @bob",
};

/**
 * `existing` is what the ownership read sees; `writeCount` is what the
 * conditional write reports (0 = the row changed under us, e.g. a concurrent
 * delete). The read-back after an edit (the call with `include`) returns the
 * row as written.
 */
function harness(existing: Record<string, unknown> | null = EXISTING, writeCount = 1) {
  let written: Record<string, unknown> = {};
  const findFirst = vi.fn(async (args: { where?: Record<string, unknown>; include?: unknown }) =>
    args.include
      ? {
          ...EXISTING,
          aiProvider: null,
          aiModel: null,
          aiSessionId: null,
          origin: "metis",
          createdAt: new Date(0),
          editedAt: null,
          deletedAt: null,
          ...written,
          authorUser: { displayName: "Alice Analyst" },
        }
      : existing,
  );
  const update = vi.fn(
    async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      written = args.data;
      return { count: writeCount };
    },
  );
  const db = { discussionMessage: { findFirst, updateMany: update } } as never;
  const emitUpdated = vi.fn();
  const emitDeleted = vi.fn();
  const dispatchMentions = vi.fn();
  return {
    findFirst,
    update,
    emitUpdated,
    emitDeleted,
    dispatchMentions,
    deps: { db, emitUpdated, emitDeleted, dispatchMentions },
  };
}

const EDIT = { threadId: "t1", projectId: "p1", messageId: "m1", actorId: "alice" };

/** The write re-checks every condition the ownership read checked. */
const OWN_LIVE_WHERE = {
  id: "m1",
  threadId: "t1",
  deletedAt: null,
  authorKind: "human",
  authorUserId: "alice",
};

beforeEach(() => vi.clearAllMocks());

describe("editHumanDiscussionMessage", () => {
  it("looks the message up inside the thread, live only", async () => {
    const h = harness();
    await editHumanDiscussionMessage({ ...EDIT, body: "hi @bob" }, h.deps);
    expect(h.findFirst.mock.calls[0][0].where).toEqual({
      id: "m1",
      threadId: "t1",
      deletedAt: null,
    });
  });

  it("lets the author edit: stamps editedAt, emits to the thread room, returns the author name", async () => {
    const h = harness();
    const row = await editHumanDiscussionMessage({ ...EDIT, body: "updated" }, h.deps);

    expect(h.update.mock.calls[0][0].where).toEqual(OWN_LIVE_WHERE);
    const data = h.update.mock.calls[0][0].data;
    expect(data.body).toBe("updated");
    expect(row.body).toBe("updated");
    expect(data.editedAt).toBeInstanceOf(Date);
    expect(row.authorName).toBe("Alice Analyst");
    expect(row).not.toHaveProperty("authorUser");
    expect(h.emitUpdated).toHaveBeenCalledWith("t1", row);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussion.message.edited",
        target: { type: "discussion_message", id: "m1" },
      }),
    );
  });

  it("refuses another member's message with NOT_AUTHOR and changes nothing", async () => {
    const h = harness();
    await expect(
      editHumanDiscussionMessage({ ...EDIT, actorId: "bob", body: "hijack" }, h.deps),
    ).rejects.toMatchObject({ code: "NOT_AUTHOR" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.emitUpdated).not.toHaveBeenCalled();
    expect(h.dispatchMentions).not.toHaveBeenCalled();
  });

  it("refuses an AI message (no human author) with NOT_AUTHOR", async () => {
    const h = harness({ ...EXISTING, authorKind: "ai", authorUserId: null });
    await expect(editHumanDiscussionMessage({ ...EDIT, body: "x" }, h.deps)).rejects.toBeInstanceOf(
      MessageChangeError,
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses a non-human row even if it names the caller as author (defence in depth)", async () => {
    // The message invariant forbids an AI row carrying authorUserId; this pins
    // the authorKind arm on its own, so it cannot be dropped silently.
    const h = harness({ ...EXISTING, authorKind: "ai", authorUserId: "alice" });
    await expect(editHumanDiscussionMessage({ ...EDIT, body: "x" }, h.deps)).rejects.toMatchObject({
      code: "NOT_AUTHOR",
    });
    await expect(deleteHumanDiscussionMessage(EDIT, h.deps)).rejects.toMatchObject({
      code: "NOT_AUTHOR",
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("answers a missing, deleted or other-thread message with MESSAGE_NOT_FOUND", async () => {
    const h = harness(null);
    await expect(editHumanDiscussionMessage({ ...EDIT, body: "x" }, h.deps)).rejects.toMatchObject({
      code: "MESSAGE_NOT_FOUND",
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("notifies only the mentions the edit ADDED, through the member-only fan-out", async () => {
    const h = harness();
    await editHumanDiscussionMessage({ ...EDIT, body: "hi @Bob and @carol" }, h.deps);
    expect(h.dispatchMentions).toHaveBeenCalledTimes(1);
    expect(h.dispatchMentions).toHaveBeenCalledWith({
      threadId: "t1",
      projectId: "p1",
      messageId: "m1",
      body: "@carol",
      authorId: "alice",
    });
  });

  it("dispatches no mentions when the edit adds none", async () => {
    const h = harness();
    await editHumanDiscussionMessage({ ...EDIT, body: "hello again @bob" }, h.deps);
    expect(h.dispatchMentions).not.toHaveBeenCalled();
  });
});

describe("deleteHumanDiscussionMessage", () => {
  it("soft-deletes the author's message and emits only its id to the thread room", async () => {
    const h = harness();
    await deleteHumanDiscussionMessage(EDIT, h.deps);
    expect(h.update.mock.calls[0][0].where).toEqual(OWN_LIVE_WHERE);
    expect(h.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(h.emitDeleted).toHaveBeenCalledWith("t1", "m1");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "discussion.message.deleted" }),
    );
  });

  it("refuses another member's message with NOT_AUTHOR", async () => {
    const h = harness();
    await expect(
      deleteHumanDiscussionMessage({ ...EDIT, actorId: "bob" }, h.deps),
    ).rejects.toMatchObject({ code: "NOT_AUTHOR" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.emitDeleted).not.toHaveBeenCalled();
  });

  it("answers a missing message with MESSAGE_NOT_FOUND", async () => {
    const h = harness(null);
    await expect(deleteHumanDiscussionMessage(EDIT, h.deps)).rejects.toMatchObject({
      code: "MESSAGE_NOT_FOUND",
    });
    expect(h.emitDeleted).not.toHaveBeenCalled();
  });

  it("a concurrent delete wins once: the second write matches nothing → not found, no emit, no audit", async () => {
    const h = harness(EXISTING, 0);
    await expect(deleteHumanDiscussionMessage(EDIT, h.deps)).rejects.toMatchObject({
      code: "MESSAGE_NOT_FOUND",
    });
    expect(h.emitDeleted).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("#734 — an edit racing a delete", () => {
  it("the conditional write matches nothing → not found, no emit, no notification, no audit", async () => {
    const h = harness(EXISTING, 0);
    await expect(
      editHumanDiscussionMessage({ ...EDIT, body: "late edit @carol" }, h.deps),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    expect(h.update.mock.calls[0][0].where).toEqual(OWN_LIVE_WHERE);
    expect(h.emitUpdated).not.toHaveBeenCalled();
    expect(h.dispatchMentions).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a row deleted between the write and the read-back is also not found, with no fan-out", async () => {
    const h = harness();
    h.findFirst.mockImplementation(async (args: { include?: unknown }) =>
      args.include ? null : EXISTING,
    );
    await expect(
      editHumanDiscussionMessage({ ...EDIT, body: "x @carol" }, h.deps),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    expect(h.emitUpdated).not.toHaveBeenCalled();
    expect(h.dispatchMentions).not.toHaveBeenCalled();
  });
});
