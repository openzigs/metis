/**
 * Epic #728 / Issue #731 — @mention resolver + Notifications fan-out.
 *
 * After a Comment is created:
 *   1. Parse all `@username` tokens from the body text.
 *   2. Resolve each username → userId via the User table.
 *   3. Persist Mention rows (dedup by unique constraint).
 *   4. Emit a socket event to each mentioned user's personal room.
 *
 * Fan-out is fire-and-forget (non-blocking). Failures are logged but never
 * propagate to the caller.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";
import { shouldNotify } from "../notifications/preferences.js";

const log = createChildLogger("collaboration:mentions");

/** Regex to extract every @username token from free text. */
const MENTION_RE = /@([A-Za-z0-9_.-]+)/g;

/**
 * Parse all `@username` tokens from a comment body.
 * Returns a deduplicated list of lowercase usernames.
 */
export function parseMentions(body: string): string[] {
  const usernames = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    if (m[1]) usernames.add(m[1].toLowerCase());
  }
  return [...usernames];
}

/**
 * Resolve a list of (already lowercased) usernames to their active User rows.
 * Silently skips usernames that don't exist — an unresolved mention is NOT an
 * error (issue #281). Never throws: a DB failure resolves to an empty list so
 * the caller (comment creation) can never be made to 500 by mention handling.
 *
 * Matching is case-insensitive: SQLite stores usernames in their original case,
 * but `@Admin` and `@admin` should both resolve to the `admin` user. We fetch
 * the candidate rows with a parameterised `OR equals` query and then filter by
 * lowercased equality in-process so the behaviour is identical on SQLite and
 * Postgres (neither needs the Postgres-only `mode: "insensitive"`).
 */
export async function resolveUsernames(
  usernames: string[],
): Promise<Array<{ id: string; username: string }>> {
  if (usernames.length === 0) return [];
  try {
    const wanted = new Set(usernames.map((u) => u.toLowerCase()));
    const candidates = await prisma.user.findMany({
      where: {
        status: "active",
        OR: usernames.map((u) => ({ username: { equals: u } })),
      },
      select: { id: true, username: true },
    });
    return candidates.filter((c) => wanted.has(c.username.toLowerCase()));
  } catch (err) {
    log.warn("resolveUsernames failed; treating all mentions as unresolved", { err });
    return [];
  }
}

/**
 * Persist Mention rows and fan-out socket notifications.
 * Called asynchronously after a comment is saved — never throws.
 *
 * @param commentId  The id of the newly created comment.
 * @param body       The raw comment body text.
 * @param authorId   The id of the comment author (excluded from self-mentions).
 */
export async function fanOutMentions(
  commentId: string,
  body: string,
  authorId: string,
): Promise<void> {
  try {
    const usernames = parseMentions(body);
    if (usernames.length === 0) return;

    const users = await resolveUsernames(usernames);
    const io = getSocketServer();

    await Promise.allSettled(
      users
        .filter((u) => u.id !== authorId) // skip self-mentions
        .map(async (u) => {
          try {
            // Upsert: the unique index on (commentId, mentionedUserId) prevents
            // duplicate notifications if fanOutMentions is called twice.
            await prisma.mention.upsert({
              where: {
                commentId_mentionedUserId: {
                  commentId,
                  mentionedUserId: u.id,
                },
              },
              update: {},
              create: {
                commentId,
                mentionedUserId: u.id,
                notified: false,
              },
            });

            // #614 — per-user preference gate (inApp × mention), enforced
            // before the socket emit + Notification row. The Mention upsert
            // above is provenance data (who was mentioned where), not a
            // notification, so it is still recorded — but `notified` stays
            // false. The helper fails OPEN (send) on any internal error.
            if (!(await shouldNotify(u.id, "inApp", "mention"))) return;

            const mentionPayload = {
              commentId,
              mentionedUserId: u.id,
              ts: Date.now(),
            };

            // Emit in-app notification via Socket.IO to the user's personal
            // room (user:{userId}). The room is auto-joined on connect from the
            // verified JWT only (OWASP A01 — no client-supplied room id).
            if (io) {
              io.to(`user:${u.id}`).emit("comment:mention", mentionPayload);
            }

            // Issue #416 — persist the notification so the drawer hydrates
            // across reloads/reconnects. Best-effort: never break the emit.
            try {
              await prisma.notification.create({
                data: {
                  userId: u.id,
                  type: "mention",
                  title: "You were mentioned in a comment",
                  message: `Comment ${commentId} mentioned you`,
                  href: `/comments/${encodeURIComponent(commentId)}`,
                  payload: JSON.stringify(mentionPayload),
                },
              });
            } catch (persistErr) {
              log.warn("Failed to persist mention notification", {
                commentId,
                userId: u.id,
                err: persistErr,
              });
            }

            // Mark as notified.
            await prisma.mention.updateMany({
              where: { commentId, mentionedUserId: u.id },
              data: { notified: true },
            });
          } catch (err) {
            log.warn("Failed to fan out mention", {
              commentId,
              userId: u.id,
              err,
            });
          }
        }),
    );
  } catch (err) {
    log.error("fanOutMentions top-level error", { commentId, err });
  }
}

/**
 * Fire-and-forget wrapper for {@link fanOutMentions}.
 *
 * Mention fan-out is a side effect that must NEVER affect the comment-creation
 * response. Posting a comment containing an `@mention` previously surfaced as a
 * 500 (issue #281); this wrapper guarantees that neither a synchronous throw
 * (during promise construction) nor an async rejection can ever propagate to —
 * or leave an unhandled rejection alongside — the request handler.
 */
export function dispatchMentions(commentId: string, body: string, authorId: string): void {
  try {
    void fanOutMentions(commentId, body, authorId).catch((err: unknown) => {
      log.error("dispatchMentions: fan-out rejected", { commentId, err });
    });
  } catch (err) {
    log.error("dispatchMentions: synchronous fan-out failure", { commentId, err });
  }
}
