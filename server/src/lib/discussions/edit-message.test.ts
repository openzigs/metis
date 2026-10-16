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

function harness(existing: Record<string, unknown> | null = EXISTING) {
  const findFirst = vi.fn().mockResolvedValue(existing);
  const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...EXISTING,
    aiProvider: null,
    aiModel: null,
    aiSessionId: null,
    origin: "metis",
    createdAt: new Date(0),
    editedAt: null,
    deletedAt: null,
    ...args.data,
    authorUser: { displayName: "Alice Analyst" },
  }));
  const db = { discussionMessage: { findFirst, update } } as never;
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

    const data = h.update.mock.calls[0][0].data;
    expect(data.body).toBe("updated");
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
    expect(h.update.mock.calls[0][0].where).toEqual({ id: "m1" });
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
});
