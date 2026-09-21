/**
 * Epic #475 (Phase 1, #476) — DiscussionMessage author invariant.
 *
 * `DiscussionMessage.authorKind` discriminates human↔human messages (which incur
 * NO AI billing) from AI replies (which link to an `AISession` for token
 * accounting). SQLite and Postgres share no portable partial-CHECK constraint we
 * rely on, so the invariant is enforced here, in application code, before every
 * insert:
 *
 *   - authorKind = "human" ⇒ authorUserId SET, aiModel/aiProvider/aiSessionId NULL
 *   - authorKind = "ai"    ⇒ aiModel SET, authorUserId NULL
 *
 * Centralising the rule (and the two `build*MessageData` constructors) means a
 * caller cannot accidentally attribute a human message to the AI (or vice-versa)
 * — the structural cost-control guarantee from the epic.
 */

export type AuthorKind = "human" | "ai";

export const AUTHOR_KINDS: readonly AuthorKind[] = ["human", "ai"];

/** Thrown when a DiscussionMessage violates the author invariant. */
export class DiscussionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscussionInvariantError";
  }
}

/** The invariant-relevant subset of a DiscussionMessage row. */
export interface MessageInvariantShape {
  authorKind: AuthorKind;
  authorUserId?: string | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiSessionId?: string | null;
  body?: string;
}

/**
 * Assert the human/ai author invariant. Throws `DiscussionInvariantError` on any
 * violation; returns void on success. Safe to call immediately before a Prisma
 * `create`.
 */
export function assertMessageInvariant(msg: MessageInvariantShape): void {
  if (!AUTHOR_KINDS.includes(msg.authorKind)) {
    throw new DiscussionInvariantError(
      `Invalid authorKind "${String(msg.authorKind)}" — must be one of ${AUTHOR_KINDS.join("|")}`,
    );
  }

  if (msg.authorKind === "human") {
    if (!msg.authorUserId) {
      throw new DiscussionInvariantError("human message requires a non-null authorUserId");
    }
    if (msg.aiModel || msg.aiProvider || msg.aiSessionId) {
      throw new DiscussionInvariantError(
        "human message must not set aiModel/aiProvider/aiSessionId",
      );
    }
    return;
  }

  // authorKind === "ai"
  if (!msg.aiModel) {
    throw new DiscussionInvariantError("ai message requires a non-null aiModel");
  }
  if (msg.authorUserId) {
    throw new DiscussionInvariantError("ai message must not set authorUserId");
  }
}

/**
 * Build a Prisma-ready data object for a HUMAN message with the AI columns
 * explicitly nulled, then assert the invariant. Use this instead of hand-rolling
 * the `create` data so the invariant is impossible to forget.
 */
export function buildHumanMessageData(input: {
  threadId: string;
  authorUserId: string;
  body: string;
}): {
  threadId: string;
  authorKind: "human";
  authorUserId: string;
  aiProvider: null;
  aiModel: null;
  aiSessionId: null;
  body: string;
} {
  const data = {
    threadId: input.threadId,
    authorKind: "human" as const,
    authorUserId: input.authorUserId,
    aiProvider: null,
    aiModel: null,
    aiSessionId: null,
    body: input.body,
  };
  assertMessageInvariant(data);
  return data;
}

/**
 * Build a Prisma-ready data object for an AI message with `authorUserId` nulled,
 * then assert the invariant. `aiSessionId` is optional (an AI reply may exist
 * before a backing session is linked).
 */
export function buildAiMessageData(input: {
  threadId: string;
  aiProvider: string;
  aiModel: string;
  aiSessionId?: string | null;
  body: string;
}): {
  threadId: string;
  authorKind: "ai";
  authorUserId: null;
  aiProvider: string;
  aiModel: string;
  aiSessionId: string | null;
  body: string;
} {
  const data = {
    threadId: input.threadId,
    authorKind: "ai" as const,
    authorUserId: null,
    aiProvider: input.aiProvider,
    aiModel: input.aiModel,
    aiSessionId: input.aiSessionId ?? null,
    body: input.body,
  };
  assertMessageInvariant(data);
  return data;
}
