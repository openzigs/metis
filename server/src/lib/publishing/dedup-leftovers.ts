/**
 * Issue #396 — find what the #369 dedup migration left behind, read-only.
 *
 * `20261001000000_issue369_issue_draft_dedup_unique` soft-deleted every live
 * duplicate of a (projectId, dedupHash) group, and #402 repointed the
 * references it could. Two leftovers need an operator, not a migration:
 *
 *   1. A retired draft that had been PUBLISHED: its remote issue still exists
 *      and duplicates the survivor's. Its published_issues rows keep their
 *      draftId on purpose — re-linking them to the survivor would attribute the
 *      issue to a body it was never published from (AC traceability and
 *      requirement sync read the draft through that row). Closing the
 *      duplicate on GitHub/Jira is the operator's call; this report names it.
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
 */
import type { PrismaClient } from "@prisma/client";

export type DedupLeftoversPrisma = Pick<PrismaClient, "issueDraft" | "publishedIssue">;

export interface PublishedRetiree {
  projectId: string;
  retiredDraftId: string;
  survivorDraftId: string;
  title: string;
  issues: Array<{
    destination: string;
    issueNumber: number;
    htmlUrl: string;
    batchId: string;
  }>;
}

export interface OrphanedChild {
  projectId: string;
  draftId: string;
  retiredParentId: string;
  /** "self": the child is its parent's survivor; "survivor": repointable (#402 not applied). */
  repair: "self" | "survivor";
  survivorDraftId: string;
}

export interface DedupLeftovers {
  retiredCount: number;
  publishedRetirees: PublishedRetiree[];
  orphanedChildren: OrphanedChild[];
}

const key = (projectId: string, dedupHash: string) => `${projectId}\u0000${dedupHash}`;

export async function findDedupLeftovers(prisma: DedupLeftoversPrisma): Promise<DedupLeftovers> {
  const deleted = await prisma.issueDraft.findMany({
    where: { deletedAt: { not: null }, dedupHash: { not: null } },
    select: { id: true, projectId: true, dedupHash: true, title: true },
    orderBy: { id: "asc" },
  });
  if (deleted.length === 0) return { retiredCount: 0, publishedRetirees: [], orphanedChildren: [] };

  const live = await prisma.issueDraft.findMany({
    where: {
      deletedAt: null,
      projectId: { in: [...new Set(deleted.map((d) => d.projectId))] },
      dedupHash: { in: [...new Set(deleted.map((d) => d.dedupHash as string))] },
    },
    select: { id: true, projectId: true, dedupHash: true },
  });
  const survivorByKey = new Map(live.map((l) => [key(l.projectId, l.dedupHash as string), l.id]));

  const retirees = new Map<string, { projectId: string; title: string; survivorId: string }>();
  for (const d of deleted) {
    const survivorId = survivorByKey.get(key(d.projectId, d.dedupHash as string));
    if (survivorId) retirees.set(d.id, { projectId: d.projectId, title: d.title, survivorId });
  }
  if (retirees.size === 0) return { retiredCount: 0, publishedRetirees: [], orphanedChildren: [] };
  const retireeIds = [...retirees.keys()];

  const issues = await prisma.publishedIssue.findMany({
    where: { draftId: { in: retireeIds }, status: { in: ["created", "updated"] } },
    select: { draftId: true, destination: true, issueNumber: true, htmlUrl: true, batchId: true },
    orderBy: [{ draftId: "asc" }, { issueNumber: "asc" }],
  });
  const publishedRetirees: PublishedRetiree[] = [];
  for (const issue of issues) {
    const r = retirees.get(issue.draftId)!;
    let entry = publishedRetirees.at(-1);
    if (entry?.retiredDraftId !== issue.draftId) {
      entry = {
        projectId: r.projectId,
        retiredDraftId: issue.draftId,
        survivorDraftId: r.survivorId,
        title: r.title,
        issues: [],
      };
      publishedRetirees.push(entry);
    }
    entry.issues.push({
      destination: issue.destination,
      issueNumber: issue.issueNumber,
      htmlUrl: issue.htmlUrl,
      batchId: issue.batchId,
    });
  }

  const children = await prisma.issueDraft.findMany({
    where: { deletedAt: null, parentDraftId: { in: retireeIds } },
    select: { id: true, projectId: true, parentDraftId: true },
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
    };
  });

  return { retiredCount: retirees.size, publishedRetirees, orphanedChildren };
}

export function formatDedupLeftovers(report: DedupLeftovers): string {
  const lines = [`${report.retiredCount} draft(s) retired by the #369 dedup migration.`];
  lines.push(
    `${report.publishedRetirees.length} retired draft(s) still have a published issue` +
      (report.publishedRetirees.length ? " (close the duplicate if it is unwanted):" : "."),
  );
  for (const r of report.publishedRetirees) {
    lines.push(
      `  project ${r.projectId}: draft ${r.retiredDraftId} (kept: ${r.survivorDraftId}) "${r.title}"`,
    );
    for (const i of r.issues) lines.push(`    ${i.destination} #${i.issueNumber} ${i.htmlUrl}`);
  }
  lines.push(
    `${report.orphanedChildren.length} live draft(s) name a retired parent` +
      (report.orphanedChildren.length ? ":" : "."),
  );
  for (const c of report.orphanedChildren) {
    lines.push(
      c.repair === "self"
        ? `  project ${c.projectId}: draft ${c.draftId} -> ${c.retiredParentId} (it is the kept draft; shown as parentless)`
        : `  project ${c.projectId}: draft ${c.draftId} -> ${c.retiredParentId} (apply migration #402 to repoint to ${c.survivorDraftId})`,
    );
  }
  return lines.join("\n");
}
