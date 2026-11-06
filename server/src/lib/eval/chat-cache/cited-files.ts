/**
 * #1845 — the repository files a chat answer cites, scored in code.
 *
 * A semantic-cache hit counts as WRONG when the answer it serves cites a
 * different set of files from a fresh run of the same question. Chat answers
 * are prose, so this reads every path-shaped token (`internal/ui/opml_import.go`,
 * `opml_import.go:12-40`, `` `rewrite/content_rewrite.go` ``) and keeps the ones
 * that name a file the repository actually holds at that point:
 *
 *   - an exact repository path, or a `<repo>/`-prefixed one;
 *   - a partial path or a bare file name that is the suffix of exactly ONE
 *     repository file. One that matches several (`handler.go`) is ambiguous and
 *     is counted, not guessed.
 *
 * A token that names no repository file (a URL host, a package import path)
 * is not a citation and is ignored.
 */

/** A path-shaped token: segments of path characters ending in a file extension. */
const PATH_TOKEN = /[A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

export interface CitedFiles {
  /** Repository-relative paths, sorted. */
  files: string[];
  /** Tokens that matched more than one repository file. */
  ambiguous: string[];
}

export function extractCitedFiles(
  answer: string,
  repoFiles: readonly string[],
  repoName?: string,
): CitedFiles {
  const files = new Set<string>();
  const ambiguous = new Set<string>();
  const known = new Set(repoFiles);
  for (const match of answer.matchAll(PATH_TOKEN)) {
    let token = match[0].replace(/^\.?\/+/, "").replace(/^\.\//, "");
    if (repoName && token.startsWith(`${repoName}/`) && !known.has(token)) {
      token = token.slice(repoName.length + 1);
    }
    if (known.has(token)) {
      files.add(token);
      continue;
    }
    const suffix = `/${token}`;
    const hits = repoFiles.filter((f) => f.endsWith(suffix));
    if (hits.length === 1) files.add(hits[0]);
    else if (hits.length > 1) ambiguous.add(token);
  }
  return { files: [...files].sort(), ambiguous: [...ambiguous].sort() };
}

/** Two citation sets name the same files (order-free). */
export function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((f) => set.has(f));
}

/** |a ∩ b| / |a ∪ b|; two empty sets are identical (1). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]).size;
  if (union === 0) return 1;
  let both = 0;
  for (const f of A) if (B.has(f)) both++;
  return both / union;
}
