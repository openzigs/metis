/**
 * #1483 — which projects a verified GitHub `issues` delivery may act on.
 *
 * Decided by the receiver from WHO SIGNED the delivery (`webhooks-github.ts`),
 * and obeyed by both consumers: the Spec Kit `tasks.md` sync
 * (`spec-kit/issue-sync.ts`) and the drift reconcile
 * (`sync/reconcile-service.ts`).
 *
 * - `project`: the delivery is for this one project only — the connector that
 *   signed it belongs to it, or (shared secret) it owns the repository under
 *   the #1475 earliest-connected-connector rule.
 * - `open`: a shared-secret delivery for a repository no project connected.
 *   Any live project except `excludeProjectIds` (those that took their own
 *   secret, and so take only what it signs) may match, and the earliest
 *   matching row wins, so the answer never depends on row order.
 *
 * Either way a soft-deleted project is never matched (the non-admin rule:
 * a deleted project is gone to everyone but an administrator, and a webhook
 * has no user).
 */
export type IssueAttribution =
  { kind: "project"; projectId: string } | { kind: "open"; excludeProjectIds: readonly string[] };

/** What a caller that names no attribution gets: any live project, deterministically. */
export const OPEN_ATTRIBUTION: IssueAttribution = { kind: "open", excludeProjectIds: [] };

/** The Prisma `projectId` filter an attribution allows. */
export function projectIdFilter(a: IssueAttribution): string | { notIn: string[] } | undefined {
  if (a.kind === "project") return a.projectId;
  return a.excludeProjectIds.length > 0 ? { notIn: [...a.excludeProjectIds] } : undefined;
}
