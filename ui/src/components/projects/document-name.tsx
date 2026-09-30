/**
 * Issue #363 — a document's name as every document list renders it: the file
 * path over the repository label for a repository file, the plain name for an
 * upload. The internal `connector:repo:…` key appears only in the tooltip.
 */
import { formatDocumentName } from "@/lib/document-name";
import type { RepoNameMap } from "@/hooks/use-repo-names";
import type { DocumentSource } from "@/lib/projects-api";

export function DocumentName({
  filename,
  source,
  repoNames,
  className,
}: {
  filename: string;
  /** #547 — the row's `documents.source`; the label classifies on it. */
  source: DocumentSource;
  repoNames?: RepoNameMap;
  className?: string;
}) {
  const name = formatDocumentName(filename, source, repoNames);
  return (
    <span
      className={`flex min-w-0 flex-col ${className ?? ""}`.trim()}
      title={name.rawId}
      data-kind={name.kind}
    >
      <PathLabel path={name.primary} />
      {name.secondary ? (
        <span className="truncate text-xs text-muted-foreground">{name.secondary}</span>
      ) : null}
    </span>
  );
}

/**
 * PR #386 review — a full path in one `truncate` span loses its file name in a
 * narrow panel, which is the part a reader scans for (#427). Only the directory
 * part shrinks; the file name never truncates.
 */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return <span className="truncate">{path}</span>;
  return (
    <span className="flex min-w-0" data-testid="document-name-path">
      <span className="truncate" data-testid="document-name-dir">
        {path.slice(0, cut + 1)}
      </span>
      <span className="shrink-0" data-testid="document-name-base">
        {path.slice(cut + 1)}
      </span>
    </span>
  );
}
