/**
 * #993 — the Spec Kit issue export's task selection and created-issue links.
 *
 * A selection is the list of chosen task ids, or `null` for every task (what
 * an export without `taskIds` covers). Pure helpers, so the page only wires them.
 */
import type { SpecKitCommandResult } from "@/lib/spec-kit-api";

/**
 * Toggle `taskId` in `selection` over `all` (tasks.md order). Selecting every
 * task collapses to `null`; the last chosen task cannot be unchosen (an export
 * of nothing is refused), so that toggle returns the selection unchanged.
 */
export function toggleTaskSelection(
  all: string[],
  selection: string[] | null,
  taskId: string,
): string[] | null {
  const chosen = new Set(selection ?? all);
  if (chosen.has(taskId)) {
    if (chosen.size === 1) return selection;
    chosen.delete(taskId);
  } else {
    chosen.add(taskId);
  }
  const next = all.filter((id) => chosen.has(id));
  return next.length === all.length ? null : next;
}

/** Whether two selections choose the same tasks (`null` is every task). */
export function sameTaskSelection(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export interface CreatedIssueLink {
  taskId: string;
  issueNumber: number;
  url: string;
}

/**
 * The GitHub issues a live export created or recorded: real issue numbers with
 * an `https://` URL only, so a dry run's `dryrun://` placeholders and anything
 * that is not a web link never become an anchor.
 */
export function createdIssueLinks(created: SpecKitCommandResult["created"]): CreatedIssueLink[] {
  return (created ?? []).flatMap((c) =>
    c.issueNumber > 0 && /^https:\/\//i.test(c.url)
      ? [{ taskId: c.taskId, issueNumber: c.issueNumber, url: c.url }]
      : [],
  );
}
