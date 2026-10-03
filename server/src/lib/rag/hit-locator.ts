/**
 * #717 — how a retrieved chunk is named and scored in model-facing text (the
 * chat RAG block and the `search-knowledge` tool).
 *
 * A repository file is named by its repository-relative `path`, never by the
 * stored `connector:repo:<id>:src/<relPath>` key: a model copies what it reads,
 * and the key's `src/` marker made it cite paths that do not exist.
 *
 * The printed score is `rankScore`, the score the list is ordered by. `score`
 * is the dense cosine, which a lexical-only hit does not have, so printing it
 * showed the model `0.000` for a hit ranked above weaker ones.
 */
import type { RetrievedChunk } from "@metis/shared";

type LocatableHit = Pick<RetrievedChunk, "filename" | "position" | "path">;
type ScorableHit = Pick<RetrievedChunk, "score" | "rankScore" | "matchedBy">;

/** `<path or filename>#<chunk position>`. */
export function formatHitLocator(hit: LocatableHit): string {
  return `${hit.path ?? hit.filename}#${hit.position}`;
}

/** `score=<rank score>`, marking a hit only the lexical retriever found. */
export function formatHitScore(hit: ScorableHit, digits: number): string {
  const value = (hit.rankScore ?? hit.score).toFixed(digits);
  const lexicalOnly = hit.matchedBy?.length === 1 && hit.matchedBy[0] === "lexical";
  return lexicalOnly ? `score=${value}, keyword match` : `score=${value}`;
}
