/**
 * Epic #475 / #547 (Phase 2 inbound, #551) — shared human-message creation.
 *
 * The REST `POST /threads/:id/messages` path (#478) and the Teams INBOUND sync
 * (#551) must produce IDENTICAL side effects when a human posts a message:
 *
 *   1. Build the row via `buildHumanMessageData` — nulls the AI columns and
 *      asserts the author invariant (`message-invariant.ts`), so a human message
 *      can never be misattributed to the AI and never incurs AI billing.
 *   2. Persist the `DiscussionMessage`, stamping an `origin` discriminator
 *      (`metis` for in-app, `teams` for a message ingested FROM a linked Teams
 *      channel). The `origin` is the #550 loop-guard seam — a `teams`-origin row
 *      is NOT mirrored back out to the channel it arrived from.
 *   3. Fan out @mention notifications to project members (#489) — fire-and-forget.
 *   4. Emit the realtime `message:new` event to the `thread:{id}` room (#481) so
 *      every connected member sees it live — an ingested Teams message therefore
 *      appears to in-app users in realtime EXACTLY like a native one.
 *   5. Schedule the outbound Teams mirror (#550) — a no-op for a `teams`-origin
 *      message thanks to the loop guard, and a real mirror for a `metis`-origin
 *      one when the thread is bridged.
 *
 * Factoring this out means the bot handler does not bypass any invariant, member
 * check, or fan-out, and the two entry points can never drift apart.
 */
import type { DiscussionMessage, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { buildHumanMessageData } from "./message-invariant.js";
import { emitMessageNew } from "./socket-emitter.js";
import { dispatchDiscussionMentions } from "./notify.js";
import { scheduleMirrorToTeams } from "../teams/outbound-sync.js";

/** #734 — a persisted message with its human author's display name, if any. */
export type DiscussionMessageWithAuthorName = DiscussionMessage & { authorName?: string };

/** #734 — read only the author's display name alongside a message row. */
export const AUTHOR_NAME_INCLUDE = { authorUser: { select: { displayName: true } } } as const;

/**
 * Flatten the `authorUser` relation to an `authorName` field, so the user row
 * itself never reaches a response or the socket.
 */
export function withAuthorName(
  row: DiscussionMessage & { authorUser?: { displayName: string | null } | null },
): DiscussionMessageWithAuthorName {
  const { authorUser, ...message } = row;
  return authorUser?.displayName ? { ...message, authorName: authorUser.displayName } : message;
}

/** Where the message came from — the #550 loop-guard discriminator. */
export type MessageOrigin = "metis" | "teams";

export interface CreateHumanMessageInput {
  threadId: string;
  /** Resolved METIS user the message is attributed to (required for human). */
  authorUserId: string;
  /** Project id of the thread (already authorized by the caller). */
  projectId: string;
  body: string;
  /** `metis` (in-app, default) | `teams` (ingested from a linked channel). */
  origin?: MessageOrigin;
}

/** The collaborators the creation orchestration touches — all injectable. */
export interface CreateHumanMessageDeps {
  db: PrismaClient;
  emit: typeof emitMessageNew;
  dispatchMentions: typeof dispatchDiscussionMentions;
  scheduleMirror: typeof scheduleMirrorToTeams;
}

function defaultDeps(): CreateHumanMessageDeps {
  return {
    db: defaultPrisma,
    emit: emitMessageNew,
    dispatchMentions: dispatchDiscussionMentions,
    scheduleMirror: scheduleMirrorToTeams,
  };
}

/**
 * Create a human `DiscussionMessage` and run the full side-effect fan-out.
 * Shared by the REST route and the Teams inbound bridge.
 *
 * Caller MUST have already authorized `authorUserId` for `threadId` (the REST
 * route via `canAccessThread`; the bot handler via `canAccessThread` against the
 * resolved sender). This function does NOT re-authorize.
 *
 * Returns the persisted message row, plus the author's display name when the
 * user has one (#734).
 */
export async function createHumanDiscussionMessage(
  input: CreateHumanMessageInput,
  overrides: Partial<CreateHumanMessageDeps> = {},
): Promise<DiscussionMessageWithAuthorName> {
  const deps: CreateHumanMessageDeps = { ...defaultDeps(), ...overrides };
  const origin: MessageOrigin = input.origin ?? "metis";

  // 1. Build + assert the human invariant (nulls AI columns).
  const base = buildHumanMessageData({
    threadId: input.threadId,
    authorUserId: input.authorUserId,
    body: input.body,
  });

  // 2. Persist, stamping the loop-guard origin. #734 — the author's display
  // name is read with the row so the live `message:new` names a teammate
  // instead of showing their raw user id; only the name is read.
  const created = await deps.db.discussionMessage.create({
    data: { ...base, origin },
    include: AUTHOR_NAME_INCLUDE,
  });
  const message = withAuthorName(created);

  // 3. @mention notifications — fire-and-forget, member-only, never throws.
  deps.dispatchMentions({
    threadId: input.threadId,
    projectId: input.projectId,
    messageId: message.id,
    body: input.body,
    authorId: input.authorUserId,
  });

  // 4. Realtime fan-out — every connected thread member sees it live.
  deps.emit(input.threadId, message);

  // 5. Outbound Teams mirror — no-op for teams-origin (loop guard) / unlinked.
  deps.scheduleMirror(input.threadId, message);

  return message;
}
