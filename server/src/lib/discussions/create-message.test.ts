import { describe, it, expect, vi, beforeEach } from "vitest";

import { createHumanDiscussionMessage } from "./create-message.js";
import { DiscussionInvariantError } from "./message-invariant.js";

function makeDeps() {
  const created = {
    id: "msg-1",
    threadId: "t-1",
    authorKind: "human",
    authorUserId: "u-1",
    aiProvider: null,
    aiModel: null,
    aiSessionId: null,
    body: "hello",
    origin: "metis",
    createdAt: new Date(),
    editedAt: null,
  };
  const create = vi.fn().mockResolvedValue(created);
  const db = { discussionMessage: { create } } as never;
  const emit = vi.fn();
  const dispatchMentions = vi.fn();
  const scheduleMirror = vi.fn();
  return { created, create, db, emit, dispatchMentions, scheduleMirror };
}

describe("createHumanDiscussionMessage", () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    h = makeDeps();
  });

  it("persists a human message defaulting origin to metis", async () => {
    await createHumanDiscussionMessage(
      { threadId: "t-1", authorUserId: "u-1", projectId: "p-1", body: "hello" },
      {
        db: h.db,
        emit: h.emit,
        dispatchMentions: h.dispatchMentions,
        scheduleMirror: h.scheduleMirror,
      },
    );
    expect(h.create).toHaveBeenCalledTimes(1);
    const data = h.create.mock.calls[0][0].data;
    expect(data.authorKind).toBe("human");
    expect(data.authorUserId).toBe("u-1");
    expect(data.origin).toBe("metis");
    // AI columns nulled by the invariant builder.
    expect(data.aiModel).toBeNull();
    expect(data.aiProvider).toBeNull();
    expect(data.aiSessionId).toBeNull();
  });

  it("stamps origin=teams when ingesting from a linked channel", async () => {
    await createHumanDiscussionMessage(
      { threadId: "t-1", authorUserId: "u-1", projectId: "p-1", body: "hi", origin: "teams" },
      {
        db: h.db,
        emit: h.emit,
        dispatchMentions: h.dispatchMentions,
        scheduleMirror: h.scheduleMirror,
      },
    );
    expect(h.create.mock.calls[0][0].data.origin).toBe("teams");
  });

  it("runs the full fan-out: mentions, realtime emit, outbound mirror", async () => {
    const msg = await createHumanDiscussionMessage(
      { threadId: "t-1", authorUserId: "u-1", projectId: "p-1", body: "@bob hi" },
      {
        db: h.db,
        emit: h.emit,
        dispatchMentions: h.dispatchMentions,
        scheduleMirror: h.scheduleMirror,
      },
    );
    expect(h.dispatchMentions).toHaveBeenCalledWith({
      threadId: "t-1",
      projectId: "p-1",
      messageId: "msg-1",
      body: "@bob hi",
      authorId: "u-1",
    });
    expect(h.emit).toHaveBeenCalledWith("t-1", h.created);
    expect(h.scheduleMirror).toHaveBeenCalledWith("t-1", h.created);
    expect(msg).toBe(h.created);
  });

  it("rejects (does not persist) when the human invariant is violated", async () => {
    await expect(
      createHumanDiscussionMessage(
        { threadId: "t-1", authorUserId: "", projectId: "p-1", body: "x" },
        {
          db: h.db,
          emit: h.emit,
          dispatchMentions: h.dispatchMentions,
          scheduleMirror: h.scheduleMirror,
        },
      ),
    ).rejects.toBeInstanceOf(DiscussionInvariantError);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
});
