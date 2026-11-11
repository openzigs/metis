/**
 * #2238 — the chat scope as a key, and the scope a session searches. Kept out
 * of the selector component so the chat page's tests, which stub the selector,
 * still get the real functions.
 */
import type { ProjectScope } from "@/components/chat/project-scope-selector";

/** A session's scope fields, as the session API returns them. */
export interface SessionScopeFields {
  projectId: string | null;
  scopeProjectIds?: string[] | null;
  scopeWorkspaceId?: string | null;
}

/** A stable key for a scope: two scopes with the same key search the same thing. */
export function scopeKeyOf(scope: ProjectScope): string {
  if (scope.mode === "workspace") return `workspace:${scope.workspaceId ?? ""}`;
  if (scope.mode === "all" || scope.projectIds.length === 0) return "all";
  return `selected:${[...scope.projectIds].sort().join(",")}`;
}

/** The scope a session searches, as a selector scope. */
export function scopeOfSession(session: SessionScopeFields): ProjectScope {
  if (session.projectId) return { mode: "selected", projectIds: [session.projectId] };
  if (session.scopeWorkspaceId) {
    return { mode: "workspace", projectIds: [], workspaceId: session.scopeWorkspaceId };
  }
  if (session.scopeProjectIds && session.scopeProjectIds.length > 0) {
    return { mode: "selected", projectIds: [...session.scopeProjectIds] };
  }
  return { mode: "all", projectIds: [] };
}

/** Whether a turn in this scope runs retrieval (anything but "All projects"). */
export function scopeSearches(scope: ProjectScope): boolean {
  return scopeKeyOf(scope) !== "all";
}
