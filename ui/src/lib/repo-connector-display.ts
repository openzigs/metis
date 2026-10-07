/**
 * Issue #364 — how a repository connector is described in lists.
 *
 * A local-directory or uploaded-archive connector has no owner, no repo name
 * and nothing to "test", so rendering it like a Git connector printed
 * "null/null" and a permanent "pending" status even after its source had been
 * ingested. These helpers give the non-Git providers their own wording.
 */
import { NON_GIT_REPO_PROVIDERS, repoConnectorSchema, type RepoConnector } from "@metis/shared";

const NON_GIT_PROVIDERS: ReadonlySet<string> = new Set(NON_GIT_REPO_PROVIDERS);

/** Providers whose source is a server directory or an uploaded archive, not a clone. */
export function isNonGitRepoProvider(provider: string): boolean {
  return NON_GIT_PROVIDERS.has(provider);
}

/**
 * The read DTO also carries the latest source ingest's outcome (#182,
 * `repo-service.ts` `toApi`), which the shared schema does not declare.
 */
export interface RepoSourceIngestSummary {
  effectiveStatus: "running" | "completed" | "partial" | "failed" | "interrupted";
}

export type RepoConnectorWithIngest = RepoConnector & {
  sourceIngest?: RepoSourceIngestSummary | null;
};

/** Where the connector's code comes from, e.g. "octocat/hello" or "Local directory". */
export function repoLocationLabel(
  r: Pick<RepoConnector, "provider" | "ownerOrOrg" | "repoName" | "hasLocalSource">,
): string {
  if (r.provider === "local") {
    return r.hasLocalSource ? "Local directory" : "Local directory (no source)";
  }
  if (r.provider === "upload") return "Uploaded archive";
  return `${r.ownerOrOrg ?? "—"}/${r.repoName ?? "—"}`;
}

const SOURCE_INGEST_LABELS: Record<RepoSourceIngestSummary["effectiveStatus"], string> = {
  running: "ingesting",
  completed: "ingested",
  partial: "partially ingested",
  failed: "ingest failed",
  interrupted: "ingest interrupted",
};

/**
 * The status to show. A Git connector's `status` is its connection test; a
 * non-Git connector is never tested, so its `status` stays `pending` forever and
 * the meaningful state is whether its source has been ingested.
 */
export function repoStatusLabel(
  r: Pick<RepoConnectorWithIngest, "provider" | "status" | "lastIngestAt" | "sourceIngest">,
): string {
  if (!isNonGitRepoProvider(r.provider) || r.status === "error" || r.status === "disabled") {
    return r.status;
  }
  if (r.sourceIngest) return SOURCE_INGEST_LABELS[r.sourceIngest.effectiveStatus];
  return r.lastIngestAt ? "ingested" : "not ingested";
}

export type RepoStatusTone = "success" | "warning" | "destructive" | "neutral";

const SOURCE_INGEST_TONES: Record<RepoSourceIngestSummary["effectiveStatus"], RepoStatusTone> = {
  running: "warning",
  completed: "success",
  partial: "warning",
  failed: "destructive",
  interrupted: "warning",
};

/**
 * The badge colour for a non-Git connector, derived from the same state
 * {@link repoStatusLabel} names — so "ingest failed" is never drawn neutral.
 * Returns `null` for a Git connector, whose badge follows its connection status.
 */
export function repoStatusTone(
  r: Pick<RepoConnectorWithIngest, "provider" | "status" | "lastIngestAt" | "sourceIngest">,
): RepoStatusTone | null {
  if (!isNonGitRepoProvider(r.provider)) return null;
  if (r.status === "error") return "destructive";
  if (r.status === "disabled") return "neutral";
  if (r.sourceIngest) return SOURCE_INGEST_TONES[r.sourceIngest.effectiveStatus];
  return r.lastIngestAt ? "success" : "neutral";
}

/**
 * #714 — an optional branch or tag typed into the create form. Empty means
 * "use the default"; anything else must pass the server's own ref rule.
 */
export function isRepoRefOrEmpty(value: string): boolean {
  const v = value.trim();
  return v === "" || repoConnectorSchema.shape.defaultBranch.safeParse(v).success;
}

/** #714 — the 7-character form of a commit SHA, as `git log --oneline` prints it. */
export function shortCommitSha(sha: string): string {
  return sha.slice(0, 7);
}
