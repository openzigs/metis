/**
 * #717 — one Knowledge search result.
 *
 * The list arrives ordered by `rankScore` (the fused rank in hybrid mode), but
 * it used to print `score`, the dense cosine, so the numbers read as unsorted
 * and a hit only the keyword retriever found printed `0.000` next to the
 * strongest answer. It now prints the score the order comes from, says when a
 * hit is a keyword match, and keeps the cosine as secondary detail.
 *
 * A repository file is named by its real path (`internal/model/feed.go`), not
 * by its stored `connector:repo:<id>:src/…` key; the key stays in the tooltip.
 */
import type { RetrievedChunk } from "@/lib/projects-api";

function matchLabel(hit: RetrievedChunk): string | null {
  const by = hit.matchedBy ?? [];
  if (by.length === 1 && by[0] === "lexical") return "keyword match";
  if (by.includes("dense")) return `similarity ${hit.score.toFixed(3)}`;
  return null;
}

export function KnowledgeSearchHit({ hit }: { hit: RetrievedChunk }) {
  const name = hit.path ?? hit.filename;
  const relevance = hit.rankScore ?? hit.score;
  const match = matchLabel(hit);
  return (
    <li className="rounded-md border p-3 text-sm" data-testid="search-hit">
      <p className="text-xs text-muted-foreground">
        <span title={hit.filename} data-testid="search-hit-name">
          {name}#{hit.position}
        </span>
        {" · "}
        <span data-testid="search-hit-relevance">relevance {relevance.toFixed(3)}</span>
        {match ? (
          <>
            {" · "}
            <span data-testid="search-hit-match">{match}</span>
          </>
        ) : null}
      </p>
      <pre className="mt-2 whitespace-pre-wrap text-sm">{hit.text}</pre>
    </li>
  );
}
