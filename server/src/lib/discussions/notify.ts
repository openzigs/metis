/**
 * Epic #475 (Phase 5, #489) — discussion @mention notifications + audit trail.
 *
 * When a human posts a discussion message, any `@username` tokens in the body
 * are resolved to users and turned into in-app `Notification` rows delivered to
 * each mentioned user's personal `user:{id}` socket room — reusing the exact
 * delivery path the comment @mention feature already uses (`collaboration/
 * mentions.ts`, room auto-joined from the verified JWT in `socket/server.ts`).
 *
 * Why a NEW module instead of reusing `fanOutMentions`:
 *   - The `Mention` Prisma model has a hard FK to `Comment` (`commentId`), so it
 *     cannot store a discussion-message mention without a schema change. We
 *     therefore persist mention provenance directly on the `Notification`
 *     payload + audit log, and use a per-(thread,user) sliding-window guard for
 *     dedup / spam control rather than the Comment-scoped unique index.
 *
 * Governance guarantees (OWASP A01 / cost + spam abuse, #490):
 *   - **Member-only delivery.** A mentioned user only receives a notification if
 *     they can actually access the thread's project (admin OR project creator,
 *     mirroring `actorCanAccessProject`). Mentioning a non-member is a no-op — no
 *     notification, no socket emit — so the feature can't be used to spam or to
 *     probe membership of arbitrary users.
 *   - **Self-mention skip.** The author never notifies themselves.
 *   - **Dedup / rate-limit.** Per (thread, mentionedUser) sliding window caps how
 *     many mention notifications one thread can generate for one user in a
 *     window — defeats mention-spam (`@victim @victim @victim …`) and rapid
 *     re-posting.
 *   - **Never throws.** Fan-out is a fire-and-forget side effect; a failure here
 *     can never break message creation (the #281 lesson).
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";
import { parseMentions, resolveUsernames } from "../collaboration/mentions.js";
import { shouldNotify } from "../notifications/preferences.js";
import { resolveRateLimitStore, type RateLimitStore } from "./rate-limit-store.js";

const log = createChildLogger("discussions:notify");

export interface DiscussionMentionInput {
  threadId: string;
  projectId: string;
  messageId: string;
  body: string;
  /** Author id — excluded from self-mentions. */
  authorId: string;
}

// ---- Membership predicate ---------------------------------------------------

/**
 * Is `userId` a member of `projectId`? Mirrors `actorCanAccessProject`'s rule
 * (admin OR project creator) but keyed by a *target* user id rather than the
 * request actor, because here we are deciding whether to notify a third party,
 * not whether the request is authorized.
 *
 * Returns false (never throws) on any DB error — failing CLOSED means a transient
 * error suppresses a notification rather than leaking one to a non-member.
 */
export async function isProjectMember(userId: string, projectId: string): Promise<boolean> {
  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { createdById: true },
    });
    if (!project) return false;
    if (project.createdById === userId) return true;

    // Admins can access every project.
    const adminRole = await prisma.userRole.findFirst({
      where: { userId, role: { key: "admin" } },
      select: { userId: true },
    });
    return adminRole != null;
  } catch (err) {
    log.warn("isProjectMember check failed; treating as non-member", { userId, projectId, err });
    return false;
  }
}

// ---- Dedup / spam guard -----------------------------------------------------

export interface MentionNotifyLimitConfig {
  /** Max mention notifications per (thread, user) within `windowMs`. */
  max: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
}

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute

const intOr = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw == null || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/**
 * Load the mention-notification limiter config (overridable via env):
 *   - `DISCUSSION_MENTION_NOTIFY_MAX`       (default 5 / window)
 *   - `DISCUSSION_MENTION_NOTIFY_WINDOW_MS` (default 60000 ms)
 */
export function loadMentionNotifyConfig(
  env: NodeJS.ProcessEnv = process.env,
): MentionNotifyLimitConfig {
  return {
    max: intOr(env.DISCUSSION_MENTION_NOTIFY_MAX, DEFAULT_MAX),
    windowMs: intOr(env.DISCUSSION_MENTION_NOTIFY_WINDOW_MS, DEFAULT_WINDOW_MS, 1000),
  };
}

/**
 * The backing store for the per-(thread,user) mention-notification window.
 * Resolved once from config; the default is in-memory/per-process, and
 * `DISCUSSION_RATE_LIMIT_BACKEND=shared` selects the process-wide shared-store
 * seam (#508) so the spam cap can hold cluster-wide. Module-scoped.
 */
let notifyStore: RateLimitStore = resolveRateLimitStore();

function notifyKey(threadId: string, userId: string): string {
  return `${threadId}::${userId}`;
}

/**
 * Sliding-window check + record for a single (thread, user) mention notification.
 * Returns true when the notification is allowed (and records it); false when the
 * window is saturated (records nothing). Pure-ish: the config is passed in.
 */
export async function allowMentionNotification(
  threadId: string,
  userId: string,
  cfg: MentionNotifyLimitConfig,
): Promise<boolean> {
  const now = Date.now();
  const res = await notifyStore.hit(notifyKey(threadId, userId), cfg.max, cfg.windowMs, now);
  return res.allowed;
}

/**
 * Test helper — clear all recorded mention-notification hits and re-resolve the
 * backing store from the current env (so a test that sets
 * `DISCUSSION_RATE_LIMIT_BACKEND` picks up the selected backend).
 */
export function __resetMentionNotifyLimiter(): void {
  void notifyStore.reset();
  notifyStore = resolveRateLimitStore();
}

/**
 * Inject a specific store (e.g. a shared instance) — used to simulate two
 * replicas sharing one backend in cross-instance tests. Returns the previous
 * store so callers can restore it.
 */
export function __setMentionNotifyStore(next: RateLimitStore): RateLimitStore {
  const prev = notifyStore;
  notifyStore = next;
  return prev;
}

// ---- Fan-out ----------------------------------------------------------------

/**
 * Resolve @mentions in a discussion message and deliver in-app notifications to
 * the mentioned project members. Never throws.
 */
export async function notifyDiscussionMentions(input: DiscussionMentionInput): Promise<void> {
  const { threadId, projectId, messageId, body, authorId } = input;
  try {
    const usernames = parseMentions(body);
    if (usernames.length === 0) return;

    const users = await resolveUsernames(usernames);
    const io = getSocketServer();
    const cfg = loadMentionNotifyConfig();

    await Promise.allSettled(
      users
        .filter((u) => u.id !== authorId) // never self-notify
        .map(async (u) => {
          try {
            // Member-only: never notify (or even probe-leak to) a non-member.
            const member = await isProjectMember(u.id, projectId);
            if (!member) return;

            // #614 — per-user preference gate (inApp × mention). The helper
            // fails OPEN (send) on any internal error and debug-logs the
            // suppression. Checked before the spam guard so a suppressed
            // mention never consumes the user's rate-limit window.
            if (!(await shouldNotify(u.id, "inApp", "mention"))) return;

            // Dedup / spam guard per (thread, user).
            if (!(await allowMentionNotification(threadId, u.id, cfg))) return;

            const payload = {
              kind: "discussion_mention" as const,
              threadId,
              messageId,
              mentionedUserId: u.id,
              ts: Date.now(),
            };

            // Persist first so the notification drawer hydrates across reloads.
            try {
              await prisma.notification.create({
                data: {
                  userId: u.id,
                  type: "discussion_mention",
                  title: "You were mentioned in a discussion",
                  message: `You were mentioned in a discussion thread`,
                  href: `/projects/${encodeURIComponent(projectId)}/discussions?thread=${encodeURIComponent(threadId)}`,
                  payload: JSON.stringify(payload),
                },
              });
            } catch (persistErr) {
              log.warn("Failed to persist discussion mention notification", {
                threadId,
                userId: u.id,
                err: persistErr,
              });
            }

            // Deliver to the user's personal room (joined from the verified JWT
            // only — OWASP A01, never a client-supplied room id).
            if (io) {
              io.to(`user:${u.id}`).emit("discussion:mention", payload);
            }
          } catch (err) {
            log.warn("Failed to fan out discussion mention", { threadId, userId: u.id, err });
          }
        }),
    );
  } catch (err) {
    log.error("notifyDiscussionMentions top-level error", { threadId, err });
  }
}

/**
 * Fire-and-forget wrapper for {@link notifyDiscussionMentions}. Guarantees no
 * synchronous throw and no async rejection can reach the message-post request.
 */
export function dispatchDiscussionMentions(input: DiscussionMentionInput): void {
  try {
    void notifyDiscussionMentions(input).catch((err: unknown) => {
      log.error("dispatchDiscussionMentions: fan-out rejected", { threadId: input.threadId, err });
    });
  } catch (err) {
    log.error("dispatchDiscussionMentions: synchronous fan-out failure", {
      threadId: input.threadId,
      err,
    });
  }
}
