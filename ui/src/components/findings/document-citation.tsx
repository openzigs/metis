/**
 * Issue #979 — one document (or database) evidence citation on a finding card.
 *
 * Extracted from the analysis page, where the leading arrow was written as the
 * JS escape `→` in JSX *text*. JSX text is not a JS string literal, so the
 * escape is not interpreted and the walkthrough saw a literal "→" on every
 * citation. The arrow is now a real character.
 *
 * Issue #427 — connector ids render as a friendly `basename — repo` label with
 * the full raw id in the title tooltip; #573 classifies on the cited row's
 * stored source, not the filename prefix. The chunk index is the provenance.
 */
import type { AnalysisDocumentCitation } from "@/lib/analysis-api";
import { formatSourceLabel } from "@/lib/format-source-label";

export function DocumentCitation({
  citation,
  repoNames,
}: {
  citation: AnalysisDocumentCitation;
  repoNames?: Readonly<Record<string, string>>;
}) {
  const source = formatSourceLabel(
    citation.filename ?? citation.documentId,
    repoNames,
    citation.source,
  );
  return (
    <li data-testid="document-citation">
      <span aria-hidden>→</span> <span title={source.rawId}>{source.label}</span> #
      {citation.chunkIndex}
      {citation.snippet ? <em className="ml-2">&quot;{citation.snippet}&quot;</em> : null}
    </li>
  );
}
