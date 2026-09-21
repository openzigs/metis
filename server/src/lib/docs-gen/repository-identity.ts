/** Stable repository/graph provenance, independent of local clone locations (#1354). */
export interface RepositoryIdentity {
  codeGraphId: string;
  repoConnectorId: string | null;
}

/** Reversible tuple encoding; no same-path or delimiter/sanitisation collisions. */
export function repositoryPathIdentity(
  repository: RepositoryIdentity | undefined,
  relativePath: string,
): string {
  if (!repository) return relativePath;
  return `repo:${encodeURIComponent(JSON.stringify([repository.repoConnectorId, repository.codeGraphId, relativePath]))}`;
}
