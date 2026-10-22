/**
 * #1323 — the name a reader sees for a module: in a section's "Shortened for
 * length" note, the Provenance panel's topic plan and `omittedTopics`.
 *
 * It was `<repository connector id> / <path>` — a database id an analyst cannot
 * read — and the repository root rendered as an empty path. Now a module is
 * named by its path, the root as {@link REPOSITORY_ROOT_LABEL}, and, only when
 * the document reads more than one repository, prefixed with the repository's
 * readable label (the connector's label, else its repository name).
 *
 * Pure: no I/O.
 */

/** How the repository-root module is named. */
export const REPOSITORY_ROOT_LABEL = "(repository root)";

/** A repository label as it may appear in a name: one line, bounded. */
const LABEL_MAX_CHARS = 60;

/** The last three segments of a module directory, or {@link REPOSITORY_ROOT_LABEL}. */
export function moduleShortName(dir: string): string {
  return dir.split("/").slice(-3).join("/") || REPOSITORY_ROOT_LABEL;
}

/** A module's readable name, prefixed with its repository label when one is given. */
export function moduleDisplayName(dir: string, repositoryLabel?: string | null): string {
  const short = moduleShortName(dir);
  return repositoryLabel ? `${repositoryLabel} / ${short}` : short;
}

/** What a repository can be called by. */
export interface RepositoryNaming {
  codeGraphId: string;
  /** The connector's label as the project named it. */
  label?: string | null;
  /** The connected repository's own name. */
  repoName?: string | null;
}

function cleanLabel(raw: string | null | undefined): string {
  const flat = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, " ")
    .replace(/\s+/g, " ");
  const trimmed = flat.trim();
  return trimmed.length > LABEL_MAX_CHARS
    ? `${trimmed.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…`
    : trimmed;
}

/**
 * The prefix for each repository's modules, by code-graph id. Empty when the
 * modules come from one repository (or none), so a single-repository project's
 * names carry no prefix. Otherwise each repository is named by its label, else
 * its repository name, else `Repository N`; two that would read the same are
 * told apart with ` (2)`, ` (3)`, … — never by an id.
 *
 * @param inUse - the code-graph ids the document's modules come from, in order.
 */
export function repositoryLabels(
  repositories: Iterable<RepositoryNaming>,
  inUse: Iterable<string>,
): Map<string, string> {
  const used = [...new Set(inUse)];
  const labels = new Map<string, string>();
  if (used.length <= 1) return labels;
  const byId = new Map<string, RepositoryNaming>();
  for (const r of repositories) byId.set(r.codeGraphId, r);
  const taken = new Map<string, number>();
  used.forEach((id, index) => {
    const repo = byId.get(id);
    const base = cleanLabel(repo?.label) || cleanLabel(repo?.repoName) || `Repository ${index + 1}`;
    const seen = (taken.get(base) ?? 0) + 1;
    taken.set(base, seen);
    labels.set(id, seen === 1 ? base : `${base} (${seen})`);
  });
  return labels;
}
