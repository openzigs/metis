/**
 * #734 — edit and delete a human discussion message.
 *
 * Authorization is layered, like the comment routes (`routes/comments.ts`):
 *
 *   1. The CALLER authorizes the actor for the thread with `canAccessThread`
 *      (the project-access rule), so a non-member gets the thread's 404 before
 *      this module runs. This module does NOT re-authorize thread access.
 *   2. Here: the message must be a live message of THAT thread (a message id
 *      from another thread is not found), and only its human author may change
 *      it. An AI message has no human author, so nobody may edit or delete it.
 *
 * Fan-out goes only to the `thread:{id}` room, which only members can join. An
 * edit notifies only the @mentions it ADDED, through the same member-only
 * fan-out a new message uses, so re-saving a message never re-notifies anyone
 * and a mention of a non-member stays a silent no-op.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { parseMentions } from "../collaboration/mentions.js";
import { dispatchDiscussionMentions } from "./notify.js";
import { emitMessageDeleted, emitMessageUpdated } from "./socket-emitter.js";
import {
  AUTHOR_NAME_INCLUDE,
  withAuthorName,
  type DiscussionMessageWithAuthorName,
} from "./create-message.js";

export type MessageChangeErrorCode = "MESSAGE_NOT_FOUND" | "NOT_AUTHOR";

/** A refused edit or delete; the route maps the code onto an HTTP status. */
export class MessageChangeError extends Error {
  constructor(
    public readonly code: MessageChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MessageChangeError";
  }
}

export interface MessageChangeTarget {
  threadId: string;
  /** The thread's project, as `canAccessThread` resolved it. */
  projectId: string;
  messageId: string;
  /** The authorized caller. */
  actorId: string;
}

export interface MessageChangeDeps {
  db: Pick<PrismaClient, "discussionMessage">;
  emitUpdated: typeof emitMessageUpdated;
  emitDeleted: typeof emitMessageDeleted;
  dispatchMentions: typeof dispatchDiscussionMentions;
}

function defaultDeps(): MessageChangeDeps {
  return {
    db: defaultPrisma,
    emitUpdated: emitMessageUpdated,
    emitDeleted: emitMessageDeleted,
    dispatchMentions: dispatchDiscussionMentions,
  };
}

/** Load the message and refuse anyone but its human author. */
async function loadOwnMessage(
  db: MessageChangeDeps["db"],
  target: MessageChangeTarget,
  verb: "edit" | "delete",
): Promise<{ id: string; body: string }> {
  const message = await db.discussionMessage.findFirst({
    where: { id: target.messageId, threadId: target.threadId, deletedAt: null },
    select: { id: true, authorKind: true, authorUserId: true, body: true },
  });
  if (!message) {
    throw new MessageChangeError("MESSAGE_NOT_FOUND", "Message not found in this thread");
  }
  if (message.authorKind !== "human" || message.authorUserId !== target.actorId) {
    throw new MessageChangeError("NOT_AUTHOR", `You can only ${verb} your own messages`);
  }
  return message;
}

/** Edit the actor's own message. Returns the updated row with its author name. */
export async function editHumanDiscussionMessage(
  input: MessageChangeTarget & { body: string },
  overrides: Partial<MessageChangeDeps> = {},
): Promise<DiscussionMessageWithAuthorName> {
  const deps: MessageChangeDeps = { ...defaultDeps(), ...overrides };
  const existing = await loadOwnMessage(deps.db, input, "edit");
  const before = new Set(parseMentions(existing.body));
  const added = parseMentions(input.body).filter((u) => !before.has(u));

  const updated = withAuthorName(
    await deps.db.discussionMessage.update({
      where: { id: existing.id },
      data: { body: input.body, editedAt: new Date() },
      include: AUTHOR_NAME_INCLUDE,
    }),
  );

  audit({
    actor: { id: input.actorId },
    action: "discussion.message.edited",
    target: { type: "discussion_message", id: existing.id },
    metadata: { threadId: input.threadId, projectId: input.projectId },
  });

  if (added.length > 0) {
    deps.dispatchMentions({
      threadId: input.threadId,
      projectId: input.projectId,
      messageId: existing.id,
      body: added.map((u) => `@${u}`).join(" "),
      authorId: input.actorId,
    });
  }

  deps.emitUpdated(input.threadId, updated);
  return updated;
}

/** Soft-delete the actor's own message. */
export async function deleteHumanDiscussionMessage(
  input: MessageChangeTarget,
  overrides: Partial<MessageChangeDeps> = {},
): Promise<void> {
  const deps: MessageChangeDeps = { ...defaultDeps(), ...overrides };
  const existing = await loadOwnMessage(deps.db, input, "delete");

  await deps.db.discussionMessage.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });

  audit({
    actor: { id: input.actorId },
    action: "discussion.message.deleted",
    target: { type: "discussion_message", id: existing.id },
    metadata: { threadId: input.threadId, projectId: input.projectId },
  });

  deps.emitDeleted(input.threadId, existing.id);
}
