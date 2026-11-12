/**
 * #2238 — the multi-product scope a chat session row carries.
 *
 * Kept free of imports so the session DTO (`conversation-service.ts`) can read
 * it without pulling in the retrieval stack (`multi-project-rag.ts`).
 */

/** What a session searches when it is scoped to more than one project. */
export type ChatSearchScope =
  { kind: "projects"; projectIds: string[] } | { kind: "workspace"; workspaceId: string };

/**
 * The multi-product scope a session row carries, or `null` for a session bound
 * to one project (`projectId`) or to none. A malformed `scopeProjectIds` reads
 * as no scope: the session then behaves as the unscoped chat it would have
 * been before #2238, and says so on its grounding badge.
 */
export function readChatSearchScope(session: {
  projectId: string | null;
  scopeProjectIds?: string | null;
  scopeWorkspaceId?: string | null;
}): ChatSearchScope | null {
  if (session.projectId) return null;
  if (session.scopeWorkspaceId) return { kind: "workspace", workspaceId: session.scopeWorkspaceId };
  const ids = parseScopeProjectIds(session.scopeProjectIds);
  return ids && ids.length >= 2 ? { kind: "projects", projectIds: ids } : null;
}

/** `scopeProjectIds` as a list of ids, or `null` when absent or malformed. */
export function parseScopeProjectIds(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const ids = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return ids.length === v.length ? [...new Set(ids)] : null;
  } catch {
    return null;
  }
}
