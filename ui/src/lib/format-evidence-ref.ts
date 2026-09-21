/**
 * Issue #448 (epic #407) — human-readable labels for cross-doc finding evidence
 * references.
 *
 * Cross-document findings (`CrossDocFindingsPanel`) reference their evidence by
 * an opaque agent `Finding` row id (a cuid). Rendered verbatim those ids are
 * unreadable for a BA/PM. The server now resolves each id at read time into a
 * {@link ResolvedEvidenceRef} carrying a `sourceLabel` (a filename/path or
 * documentId) and an optional `line`. This pure formatter turns that ref — or,
 * when the server could not resolve it, the raw id — into a `{ label, rawId,
 * title }` triple for the chip.
 *
 * Reuses {@link formatSourceLabel} (#427) so a `connector:repo:<id>:<path>`
 * source collapses to a scannable `basename — repo` label, consistent with the
 * doc picker / citations.
 *
 * Graceful degradation: an unresolved ref (no `sourceLabel`) or a bare raw id
 * falls back to the raw id as both `label` and `title` — exactly the prior
 * behaviour. The formatter is pure and never throws on malformed input.
 */
import { formatSourceLabel } from "./format-source-label";
import type { ResolvedEvidenceRef } from "./analysis-api";

export interface EvidenceRefLabel {
  /** Human-readable chip text — a readable source (+ `#line`) when resolved,
   *  otherwise the raw id unchanged. Never blank for non-blank input. */
  label: string;
  /** The raw evidence/finding id — preserved verbatim for the tooltip / copy. */
  rawId: string;
  /** The tooltip text. Always contains the raw id so the opaque source stays
   *  discoverable on hover. */
  title: string;
}

/**
 * Format a resolved evidence ref (or a bare raw id) into chip text.
 *
 * - Resolved (has `sourceLabel`): `label` is `formatSourceLabel(sourceLabel).label`
 *   with ` #<line>` appended when a line is present; `rawId` / `title` are the
 *   raw `chunkId`.
 * - Unresolved ref or bare string: `label` and `title` are the raw id
 *   (graceful degradation == the prior raw-chip behaviour).
 */
export function formatEvidenceRef(refOrRawId: ResolvedEvidenceRef | string): EvidenceRefLabel {
  if (typeof refOrRawId === "string") {
    const rawId = refOrRawId;
    return { label: rawId, rawId, title: rawId };
  }

  const ref = refOrRawId;
  const rawId = ref.chunkId;

  // Unresolvable (legacy / deleted finding): degrade to the raw id.
  if (!ref.sourceLabel) {
    return { label: rawId, rawId, title: rawId };
  }

  const { label } = formatSourceLabel(ref.sourceLabel);
  const base = label || rawId;
  const withLine = typeof ref.line === "number" ? `${base} #${ref.line}` : base;
  return { label: withLine, rawId, title: rawId };
}
