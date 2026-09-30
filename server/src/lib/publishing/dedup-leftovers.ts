/**
 * Issue #396 — find what the #369 dedup migration left behind, read-only.
 *
 * `20261001000000_issue369_issue_draft_dedup_unique` soft-deleted every live
 * duplicate of a (projectId, dedupHash) group, and #402 repointed the
 * references it could. Two leftovers need an operator, not a migration:
 *
 *   1. A retired draft that had been PUBLISHED. Its published_issues rows
 *      keep their draftId on purpose — re-linking them to the survivor would
 *      attribute the issue to a body it was never published from (AC
 *      traceability and requirement sync read the draft through that row).
 *      Such a row is NOT necessarily a duplicate issue. A draft's dedupHash is
 *      the key the GitHub publisher dedups on, so publishing the survivor (or
 *      its twin in the same batch) usually UPDATED the retiree's issue and
 *      wrote a row with the same issue number: both drafts point at one
 *      issue, and closing it would close the survivor's. So each retiree
 *      issue is compared with the survivor's live issues and reported either
 *      as shared (nothing to close) or as a separate issue that may duplicate
 *      the survivor's — closing that one is the operator's call.
 *   2. A live draft whose parent is a retired draft. After #402 only the case
 *      where the child is itself its group's survivor remains ("self"), since
 *      repointing would make it its own parent. Every reader already treats it
 *      as parentless. "survivor" means #402 has not run on this database yet.
 *
 * A retiree is "soft-deleted with a live row of the same (projectId,
 * dedupHash)": no application path soft-deletes an issue draft, and the
 * partial unique index allows one live row per key, so that names exactly
 * #369's retirees and their survivor. Every match is on projectId AND
 * dedupHash, never the hash alone.
 *
 * That rule also matches any row soft-deleted by other means before #369 ran
 * (a manual fix, a restored backup). So retirees are grouped by deletedAt:
 * #369 retired all of its duplicates in one UPDATE at one CURRENT_TIMESTAMP,
 * and any other timestamp is a separate soft-delete the report does not
 * attribute to it.
 *
 * Leftovers in an archived project (the project row is soft-deleted) are
 * flagged, since an operator may not care about them.
 */
import type { PrismaClient } from "@prisma/client";

export type DedupLeftoversPrisma = Pick<PrismaClient, "issueDraft" | "publishedIssue">;

export interface PublishedRetiree {
  projectId: string;
  retiredDraftId: string;
  survivorDraftId: string;
  title: string;
  /** The draft's project is archived (soft-deleted). */
  projectArchived: boolean;
  issues: Array<{
    destination: string;
    issueNumber: number;
    htmlUrl: string;
    batchId: string;
    /**
     * The published_issues status. "failed" still means a live remote issue:
     * since #1091 the GitHub publisher records the real issue on a row whose
     * create succeeded and a later step failed, and rollback closes it only
     * when more than half the batch failed.
     */
    status: string;
    /**
     * The survivor has a live published row for this same remote issue: same
     * non-empty htmlUrl, or same destination, target repository and
     * issueNumber (> 0). Not a duplicate — closing it closes the survivor's.
     */
    sharedWithSurvivor: boolean;
  }>;
  /** Live published rows the survivor has; 0 means the retiree's issue may be the only one. */
  survivorIssueCount: number;
}

export interface OrphanedChild {
  projectId: string;
  draftId: string;
  retiredParentId: string;
  /** "self": the child is its parent's survivor; "survivor": repointable (#402 not applied). */
  repair: "self" | "survivor";
  survivorDraftId: string;
  /** The draft's project is archived (soft-deleted). */
  projectArchived: boolean;
}

export interface DedupLeftovers {
  retiredCount: number;
  /** Retirees per deletedAt (ISO 8601), oldest first; #369's run is one entry. */
  retiredByDeletedAt: Array<{ deletedAt: string; count: number }>;
  publishedRetirees: PublishedRetiree[];
  orphanedChildren: OrphanedChild[];
}

const EMPTY: DedupLeftovers = {
  retiredCount: 0,
  retiredByDeletedAt: [],
  publishedRetirees: [],
  orphanedChildren: [],
};

const key = (projectId: string, dedupHash: string) => `${projectId}\u0000${dedupHash}`;

interface IssueRow {
  destination: string;
  issueNumber: number;
  htmlUrl: string;
  batch: { targetBaseUrl: string | null; targetOwner: string; targetRepo: string };
}

/**
 * One remote issue: the same non-empty htmlUrl, or the same destination,
 * target repository and issue number. Jira rows store issueNumber 0, so they
 * match on the URL alone; a number is only unique within one repository.
 */
function sameRemoteIssue(a: IssueRow, b: IssueRow): boolean {
  if (a.htmlUrl !== "" && a.htmlUrl === b.htmlUrl) return true;
  return (
    a.issueNumber > 0 &&
    a.issueNumber === b.issueNumber &&
    a.destination === b.destination &&
    (a.batch.targetBaseUrl ?? "") === (b.batch.targetBaseUrl ?? "") &&
    a.batch.targetOwner === b.batch.targetOwner &&
    a.batch.targetRepo === b.batch.targetRepo
  );
}

export async function findDedupLeftovers(prisma: DedupLeftoversPrisma): Promise<DedupLeftovers> {
  const deleted = await prisma.issueDraft.findMany({
    where: { deletedAt: { not: null }, dedupHash: { not: null } },
    select: {
      id: true,
      projectId: true,
      dedupHash: true,
      title: true,
      deletedAt: true,
      project: { select: { deletedAt: true } },
    },
    orderBy: { id: "asc" },
  });
  if (deleted.length === 0) return EMPTY;

  const live = await prisma.issueDraft.findMany({
    where: {
      deletedAt: null,
      projectId: { in: [...new Set(deleted.map((d) => d.projectId))] },
      dedupHash: { in: [...new Set(deleted.map((d) => d.dedupHash as string))] },
    },
    select: { id: true, projectId: true, dedupHash: true },
  });
  const survivorByKey = new Map(live.map((l) => [key(l.projectId, l.dedupHash as string), l.id]));

  const retirees = new Map<
    string,
    { projectId: string; title: string; survivorId: string; projectArchived: boolean }
  >();
  const byDeletedAt = new Map<number, number>();
  for (const d of deleted) {
    const survivorId = survivorByKey.get(key(d.projectId, d.dedupHash as string));
    if (!survivorId) continue;
    retirees.set(d.id, {
      projectId: d.projectId,
      title: d.title,
      survivorId,
      projectArchived: d.project.deletedAt !== null,
    });
    const at = (d.deletedAt as Date).getTime();
    byDeletedAt.set(at, (byDeletedAt.get(at) ?? 0) + 1);
  }
  if (retirees.size === 0) return EMPTY;
  const retiredByDeletedAt = [...byDeletedAt]
    .sort(([a], [b]) => a - b)
    .map(([at, count]) => ({ deletedAt: new Date(at).toISOString(), count }));
  const retireeIds = [...retirees.keys()];

  // A failed row counts only if it still points at a real remote issue
  // (#1091). A failure before the remote write stores 0/"" (Jira stores an
  // empty key and URL), so those stay out. The survivors' rows are read with
  // the same filter, to tell a shared issue from a separate one.
  const survivorIds = [...new Set([...retirees.values()].map((r) => r.survivorId))];
  const rows = await prisma.publishedIssue.findMany({
    where: {
      draftId: { in: [...retireeIds, ...survivorIds] },
      OR: [
        { status: { in: ["created", "updated"] } },
        { status: "failed", OR: [{ issueNumber: { gt: 0 } }, { htmlUrl: { not: "" } }] },
      ],
    },
    select: {
      draftId: true,
      destination: true,
      issueNumber: true,
      htmlUrl: true,
      batchId: true,
      status: true,
      batch: { select: { targetBaseUrl: true, targetOwner: true, targetRepo: true } },
    },
    orderBy: [{ draftId: "asc" }, { issueNumber: "asc" }],
  });
  const survivorIssues = new Map<string, typeof rows>();
  for (const row of rows) {
    if (retirees.has(row.draftId)) continue;
    survivorIssues.set(row.draftId, [...(survivorIssues.get(row.draftId) ?? []), row]);
  }
  const publishedRetirees: PublishedRetiree[] = [];
  for (const issue of rows) {
    const r = retirees.get(issue.draftId);
    if (!r) continue;
    const kept = survivorIssues.get(r.survivorId) ?? [];
    let entry = publishedRetirees.at(-1);
    if (entry?.retiredDraftId !== issue.draftId) {
      entry = {
        projectId: r.projectId,
        retiredDraftId: issue.draftId,
        survivorDraftId: r.survivorId,
        title: r.title,
        projectArchived: r.projectArchived,
        issues: [],
        survivorIssueCount: kept.length,
      };
      publishedRetirees.push(entry);
    }
    entry.issues.push({
      destination: issue.destination,
      issueNumber: issue.issueNumber,
      htmlUrl: issue.htmlUrl,
      batchId: issue.batchId,
      status: issue.status,
      sharedWithSurvivor: kept.some((k) => sameRemoteIssue(issue, k)),
    });
  }

  const children = await prisma.issueDraft.findMany({
    where: { deletedAt: null, parentDraftId: { in: retireeIds } },
    select: {
      id: true,
      projectId: true,
      parentDraftId: true,
      project: { select: { deletedAt: true } },
    },
    orderBy: { id: "asc" },
  });
  const orphanedChildren: OrphanedChild[] = children.map((c) => {
    const parent = retirees.get(c.parentDraftId as string)!;
    return {
      projectId: c.projectId,
      draftId: c.id,
      retiredParentId: c.parentDraftId as string,
      repair: parent.survivorId === c.id ? "self" : "survivor",
      survivorDraftId: parent.survivorId,
      projectArchived: c.project.deletedAt !== null,
    };
  });

  return { retiredCount: retirees.size, retiredByDeletedAt, publishedRetirees, orphanedChildren };
}

/**
 * Every free-text field below (the model-written title above all) goes to an
 * operator's terminal. Replace each C0/C1 control character, ESC, CR and LF
 * included, so a value can neither inject an escape sequence nor add a line.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const t = (value: string | number): string => String(value).replace(CONTROL, "?");

const project = (id: string, archived: boolean) =>
  `project ${t(id)}${archived ? " (archived)" : ""}`;

export function formatDedupLeftovers(report: DedupLeftovers): string {
  const lines = [
    `${report.retiredCount} soft-deleted draft(s) have a live twin` +
      (report.retiredCount
        ? ", by deletedAt (#369 retired its duplicates at one timestamp; any other is a separate soft-delete):"
        : "."),
  ];
  for (const g of report.retiredByDeletedAt) lines.push(`  ${t(g.deletedAt)}: ${t(g.count)}`);
  const pick = (shared: boolean) =>
    report.publishedRetirees
      .map((r) => ({ ...r, issues: r.issues.filter((i) => i.sharedWithSurvivor === shared) }))
      .filter((r) => r.issues.length > 0);
  const separate = pick(false);
  const shared = pick(true);
  const count = (rs: PublishedRetiree[]) => rs.reduce((n, r) => n + r.issues.length, 0);
  lines.push(
    `${report.publishedRetirees.length} retired draft(s) still have a published issue` +
      (report.publishedRetirees.length
        ? `: ${count(separate)} separate issue(s) to review, ${count(shared)} the same issue as the kept draft.`
        : "."),
  );
  const list = (rs: PublishedRetiree[]) => {
    for (const r of rs) {
      const alone = r.survivorIssueCount === 0 ? " (the kept draft has no published issue)" : "";
      lines.push(
        `  ${project(r.projectId, r.projectArchived)}: draft ${t(r.retiredDraftId)} (kept: ${t(r.survivorDraftId)}) "${t(r.title)}"${alone}`,
      );
      for (const i of r.issues) {
        const note = i.status === "failed" ? " (publish marked failed; remote issue exists)" : "";
        lines.push(
          `    ${t(i.destination)} #${t(i.issueNumber)} ${t(i.htmlUrl)} [${t(i.status)}]${note}`,
        );
      }
    }
  };
  if (separate.length) {
    lines.push(
      "Separate issue(s), possibly duplicating the kept draft's (close one if unwanted; check first when the kept draft has none):",
    );
    list(separate);
  }
  if (shared.length) {
    lines.push("Same issue as the kept draft, not a duplicate (leave it open; no action):");
    list(shared);
  }
  lines.push(
    `${report.orphanedChildren.length} live draft(s) name a retired parent` +
      (report.orphanedChildren.length ? ":" : "."),
  );
  for (const c of report.orphanedChildren) {
    const head = `  ${project(c.projectId, c.projectArchived)}: draft ${t(c.draftId)} -> ${t(c.retiredParentId)}`;
    lines.push(
      c.repair === "self"
        ? `${head} (it is the kept draft; shown as parentless)`
        : `${head} (apply migration #402 to repoint to ${t(c.survivorDraftId)})`,
    );
  }
  return lines.join("\n");
}
