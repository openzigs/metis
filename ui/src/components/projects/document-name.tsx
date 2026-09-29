/**
 * Issue #363 — a document's name as every document list renders it: the file
 * path over the repository label for a repository file, the plain name for an
 * upload. The internal `connector:repo:…` key appears only in the tooltip.
 */
import { formatDocumentName } from "@/lib/document-name";
import type { RepoNameMap } from "@/hooks/use-repo-names";

export function DocumentName({
  filename,
  repoNames,
  className,
}: {
  filename: string;
  repoNames?: RepoNameMap;
  className?: string;
}) {
  const name = formatDocumentName(filename, repoNames);
  return (
    <span
      className={`flex min-w-0 flex-col ${className ?? ""}`.trim()}
      title={name.rawId}
      data-kind={name.kind}
    >
      <span className="truncate">{name.primary}</span>
      {name.secondary ? (
        <span className="truncate text-xs text-muted-foreground">{name.secondary}</span>
      ) : null}
    </span>
  );
}
