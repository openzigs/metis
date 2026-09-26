/**
 * Epic #127 — who may read, resume, fork or continue a chat session.
 *
 * A session is reachable when BOTH hold:
 *
 *   1. the caller owns it (`ai_sessions.userId`) and it is not deleted; and
 *   2. when it is bound to a project, the caller can STILL reach that project
 *      — checked through `assertProjectAccess`, the canonical object-level
 *      project-scope seam (#673). Losing workspace membership therefore also
 *      loses the project's chats, including their retrieved project content.
 *
 * Every failure answers 404 with the same code, so a probe cannot tell
 * "another user's session", "a project you left" and "no such id" apart.
 */
import type { AISession } from "@prisma/client";
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../../prisma.js";
import { AppError } from "../../../middleware/error-handler.js";
import { assertProjectAccess } from "../../custom-agents/authz.js";
import { isRetiredProviderKey, retiredProviderMessage } from "../retired-providers.js";

export const SESSION_NOT_FOUND = "AI_SESSION_NOT_FOUND";

function notFound(): AppError {
  return new AppError(404, SESSION_NOT_FOUND, "Session not found");
}

export async function loadAuthorizedSession(
  user: AuthPayload | undefined,
  sessionId: string,
): Promise<AISession> {
  if (!user?.userId) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  const session = await prisma.aISession.findFirst({
    where: { id: sessionId, userId: user.userId, deletedAt: null },
  });
  if (!session) throw notFound();
  if (session.projectId) {
    try {
      await assertProjectAccess(user, session.projectId);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw notFound();
      throw err;
    }
  }
  return session;
}

/** #149 — the error code a read-only (retired-provider) session answers with. */
export const SESSION_PROVIDER_RETIRED = "AI_SESSION_PROVIDER_RETIRED";

/**
 * #149 — why a session can no longer take a turn, or `null` when it can.
 *
 * A session created on a provider METIS no longer ships (`copilot-native`)
 * stays readable — transcript, resume and the session list all work — but it
 * is READ-ONLY: its stored provider cannot run, and quietly answering the next
 * turn on whatever provider is configured now would move a conversation to a
 * backend the user never chose for it.
 */
export function sessionReadOnlyReason(session: Pick<AISession, "provider">): string | null {
  return isRetiredProviderKey(session.provider)
    ? retiredProviderMessage(session.provider, "session")
    : null;
}

/**
 * Refuse any operation that would run a model on a read-only session (a chat
 * or stream turn, an async message, an on-demand compaction) with a 409 whose
 * message says why and what to do.
 */
export function assertSessionAcceptsTurns(session: Pick<AISession, "provider">): void {
  const reason = sessionReadOnlyReason(session);
  if (reason) throw new AppError(409, SESSION_PROVIDER_RETIRED, reason);
}
