/**
 * #733 — the GitHub repository a publish files into.
 *
 * Every publish surface used to default to the repo connector's own repository,
 * which for an analysed open-source project is its upstream. These helpers keep
 * the target explicit: drafts carry the target they were generated for, and a
 * target that is the analysed repository itself is called out.
 */

export interface PublishTarget {
  owner: string;
  repo: string;
}

function readTarget(metadata: string | null | undefined): PublishTarget | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { targetOwner?: unknown; targetRepo?: unknown };
    const { targetOwner, targetRepo } = parsed;
    if (typeof targetOwner !== "string" || typeof targetRepo !== "string") return null;
    if (!targetOwner || !targetRepo) return null;
    return { owner: targetOwner, repo: targetRepo };
  } catch {
    return null;
  }
}

/**
 * The one target every given draft was generated for, or null when there are
 * no drafts, any draft predates #733 (records none), or they disagree — a
 * guess between two repositories is exactly what this must not make.
 */
export function commonDraftTarget(
  drafts: ReadonlyArray<{ metadata?: string | null }>,
): PublishTarget | null {
  let common: PublishTarget | null = null;
  for (const d of drafts) {
    const t = readTarget(d.metadata);
    if (!t) return null;
    if (!common) common = t;
    else if (!sameTarget(common, t)) return null;
  }
  return common;
}

/**
 * True when the drafts cannot share one inherited target: at least one records
 * a target and they do not all record the same one. Falling back to some other
 * target then would publish drafts deduplicated against repository A into B.
 */
export function draftTargetsConflict(drafts: ReadonlyArray<{ metadata?: string | null }>): boolean {
  return drafts.some((d) => readTarget(d.metadata)) && !commonDraftTarget(drafts);
}

/** GitHub owner and repository names are case-insensitive. */
export function sameTarget(a: PublishTarget, b: PublishTarget): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * True when `target` is the repository the project's repo connector analyses —
 * for an open-source project, its upstream, where filing issues is rarely meant.
 */
export function isAnalysedRepo(
  target: { owner: string; repo: string },
  connector: { ownerOrOrg?: string | null; repoName?: string | null } | null | undefined,
): boolean {
  if (!connector?.ownerOrOrg || !connector.repoName) return false;
  if (!target.owner || !target.repo) return false;
  return sameTarget(target, { owner: connector.ownerOrOrg, repo: connector.repoName });
}
