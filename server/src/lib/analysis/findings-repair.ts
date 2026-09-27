/**
 * #298 — repair the two field-length violations that invalidated whole
 * agentic findings answers, instead of letting one field cost every finding.
 *
 * Measured on #214 (DeepSeek-flash, both tool protocols): every invalid
 * analysis answer was a `too_big` in `agentOutputSchema` — a citation
 * `documentId` that was really a file path or a text excerpt, or a `notes`
 * entry over 512 characters. One such field failed the whole object, the pass
 * degraded, and salvage (which re-applies the same per-finding schema) lost the
 * finding that carried the bad citation too.
 *
 * What this does, per field, and nothing else:
 *   - a citation `documentId` the schema would reject is resolved to the real
 *     id when it names exactly one known document (by filename / path) AND the
 *     resolved citation is a complete document citation (a missing `chunkIndex`
 *     is recovered from a `#chunkN` anchor), and is otherwise REMOVED from the
 *     citation — so whether documents were supplied never changes the
 *     verdict. A citation left with no valid identity (no `documentId`, and
 *     not a complete code citation) is removed from the finding — the FINDING
 *     always survives;
 *   - a `notes` entry over the limit is truncated with an ellipsis.
 *
 * The stored limits stay the contract: nothing here widens a schema, and the
 * result is still validated by `agentOutputSchema` afterwards, so a genuinely
 * malformed answer (wrong types, missing required fields, bad enums the schema
 * does not already coerce) is still rejected. Every repair is returned so the
 * caller records it — no finding, citation or note text is lost silently.
 *
 * Pure: no provider, no database. The caller supplies the known documents.
 */
import { codeCitationSchema, documentCitationSchema } from "@metis/shared";

/** A project document a model-authored `documentId` may be resolved against. */
export interface KnownDocument {
  id: string;
  filename: string;
}

export type FindingsRepairKind =
  /** An invalid `documentId` named exactly one known document; replaced by its id. */
  | "document-id-resolved"
  /** An invalid `documentId` matched no known document; removed, the citation kept (it is a valid code citation). */
  | "document-id-dropped"
  /** An invalid `documentId` matched no known document and the citation had no other identity; the citation was removed. */
  | "citation-dropped"
  /** A `notes` entry over the limit was truncated with an ellipsis. */
  | "note-truncated";

/**
 * One repair. Deliberately carries no model-authored text: the original value
 * is commentary on the customer's material, so only its length is kept.
 */
export interface FindingsRepair {
  kind: FindingsRepairKind;
  /** Where in the model's own answer, e.g. `findings.1.citations.3` or `notes.0`. */
  path: string;
  /** Length of the value that was repaired. */
  originalLength: number;
}

export interface FindingsRepairResult {
  /** The repaired answer — a copy; the input is never mutated. */
  value: unknown;
  repairs: FindingsRepair[];
}

/**
 * The stored `notes` limits in `agentOutputSchema` (`@metis/shared`). Restated
 * rather than introspected from Zod internals; `findings-repair.test.ts` pins
 * both against the schema itself, so a drift fails a test instead of a run.
 */
export const NOTE_MAX_LENGTH = 512;
export const NOTES_MAX_COUNT = 20;

const ELLIPSIS = "\u2026";

const documentIdSchema = documentCitationSchema.shape.documentId;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True when `documentId` is a string the stored citation contract would reject. */
function isInvalidDocumentId(value: unknown): value is string {
  return typeof value === "string" && !documentIdSchema.safeParse(value).success;
}

/**
 * Does this answer carry a citation `documentId` the schema would reject? Lets
 * the caller skip loading documents for the (normal) answer that needs none.
 */
export function answerNeedsDocumentResolution(parsed: unknown): boolean {
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return false;
  return parsed.findings.some(
    (f) =>
      isRecord(f) &&
      Array.isArray(f.citations) &&
      f.citations.some((c) => isRecord(c) && isInvalidDocumentId(c.documentId)),
  );
}

/** `docs/spec/Loan Terms.md#chunk3` → `loan terms.md`. */
function normaliseDocumentName(value: string): string {
  const withoutAnchor = value.trim().replace(/#.*$/s, "");
  const parts = withoutAnchor.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").trim().toLowerCase();
}

/** The one known document `value` names, or `undefined` when none or several do. */
function resolveDocument(value: string, known: readonly KnownDocument[]): string | undefined {
  const name = normaliseDocumentName(value);
  if (!name) return undefined;
  const matches = new Set(
    known.filter((d) => normaliseDocumentName(d.filename) === name).map((d) => d.id),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** `Loan Terms.md#chunk3` → 3 — the anchor `search_knowledge` prints a hit with. */
function chunkIndexFromAnchor(value: string): number | undefined {
  const m = /#chunk(\d+)\s*$/i.exec(value);
  return m ? Number(m[1]) : undefined;
}

/**
 * The citation with its `documentId` resolved to a known document's real id —
 * but ONLY when the result is a complete, valid document citation. A missing
 * `chunkIndex` is recovered from a `#chunkN` anchor on the id the model wrote;
 * anything still invalid returns `undefined`, so the caller falls through to
 * dropping the id exactly as it would with no document list. That keeps the
 * repair's VERDICT independent of whether documents were supplied: the #1314
 * gate (no documents) and the orchestrator / salvage (documents) never
 * disagree about whether an answer is valid.
 */
function resolveDocumentCitation(
  citation: Record<string, unknown>,
  documentId: string,
  known: readonly KnownDocument[],
): Record<string, unknown> | undefined {
  const id = resolveDocument(documentId, known);
  if (id === undefined) return undefined;
  const candidate: Record<string, unknown> = { ...citation, documentId: id };
  if (candidate.chunkIndex === undefined) {
    const anchored = chunkIndexFromAnchor(documentId);
    if (anchored !== undefined) candidate.chunkIndex = anchored;
  }
  return documentCitationSchema.safeParse(candidate).success ? candidate : undefined;
}

function truncateNote(note: string, max: number): string {
  let cut = max - ELLIPSIS.length;
  // Never leave half a surrogate pair before the ellipsis.
  const code = note.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return note.slice(0, cut) + ELLIPSIS;
}

/**
 * Repair one finding's citations in place (on an already-copied finding).
 * `prefix` is the finding's path in the answer (`findings.1`).
 */
function repairCitations(
  finding: Record<string, unknown>,
  prefix: string,
  known: readonly KnownDocument[],
  repairs: FindingsRepair[],
): void {
  if (!Array.isArray(finding.citations)) return;
  const kept: unknown[] = [];
  finding.citations.forEach((citation, j) => {
    if (!isRecord(citation) || !isInvalidDocumentId(citation.documentId)) {
      kept.push(citation);
      return;
    }
    const path = `${prefix}.citations.${j}`;
    const originalLength = citation.documentId.length;
    const resolved = resolveDocumentCitation(citation, citation.documentId, known);
    if (resolved !== undefined) {
      kept.push(resolved);
      repairs.push({ kind: "document-id-resolved", path, originalLength });
      return;
    }
    const { documentId: _dropped, ...rest } = citation;
    if (codeCitationSchema.safeParse(rest).success) {
      kept.push(rest);
      repairs.push({ kind: "document-id-dropped", path, originalLength });
    } else {
      repairs.push({ kind: "citation-dropped", path, originalLength });
    }
  });
  finding.citations = kept;
}

/**
 * Repair one model-authored finding (the salvage path's unit). `path` is its
 * position in the model's answer, used only to label the repairs.
 */
export function repairFinding(
  finding: unknown,
  path: string,
  opts: { knownDocuments?: readonly KnownDocument[] } = {},
): FindingsRepairResult {
  if (!isRecord(finding)) return { value: finding, repairs: [] };
  const repairs: FindingsRepair[] = [];
  const copy = structuredClone(finding);
  repairCitations(copy, path, opts.knownDocuments ?? [], repairs);
  return { value: copy, repairs };
}

/** Repair a whole parsed findings answer. Non-object input is returned as is. */
export function repairFindingsAnswer(
  parsed: unknown,
  opts: { knownDocuments?: readonly KnownDocument[] } = {},
): FindingsRepairResult {
  if (!isRecord(parsed)) return { value: parsed, repairs: [] };
  const repairs: FindingsRepair[] = [];
  const copy = structuredClone(parsed);
  const known = opts.knownDocuments ?? [];

  if (Array.isArray(copy.findings)) {
    copy.findings.forEach((finding, i) => {
      if (isRecord(finding)) repairCitations(finding, `findings.${i}`, known, repairs);
    });
  }

  if (Array.isArray(copy.notes)) {
    copy.notes = copy.notes.map((note, i) => {
      if (typeof note !== "string" || note.length <= NOTE_MAX_LENGTH) return note;
      repairs.push({ kind: "note-truncated", path: `notes.${i}`, originalLength: note.length });
      return truncateNote(note, NOTE_MAX_LENGTH);
    });
  }

  return { value: copy, repairs };
}

/**
 * {@link repairFindingsAnswer}, loading the known documents only when the
 * answer actually has a `documentId` to resolve. A loader failure degrades to
 * "no known documents" (the id is dropped rather than resolved) — resolving an
 * id must never be able to fail the pass it is rescuing.
 */
export async function repairFindingsAnswerWithDocuments(
  parsed: unknown,
  loadKnownDocuments: () => Promise<readonly KnownDocument[]>,
): Promise<FindingsRepairResult> {
  let knownDocuments: readonly KnownDocument[] = [];
  if (answerNeedsDocumentResolution(parsed)) {
    try {
      knownDocuments = await loadKnownDocuments();
    } catch {
      knownDocuments = [];
    }
  }
  return repairFindingsAnswer(parsed, { knownDocuments });
}

/** `2 document-id-resolved, 1 note-truncated` — counts only, stable order. */
export function summarizeFindingsRepairs(repairs: readonly FindingsRepair[]): string {
  const counts = new Map<FindingsRepairKind, number>();
  for (const r of repairs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
}

/**
 * The note that records a pass's repairs on the persisted output, or
 * `undefined` when there were none. Bounded by the note limit.
 */
export function findingsRepairNote(repairs: readonly FindingsRepair[]): string | undefined {
  if (repairs.length === 0) return undefined;
  const note =
    `REPAIRED: ${repairs.length} over-limit field(s) in the model's findings answer were ` +
    `repaired instead of rejecting the answer (${summarizeFindingsRepairs(repairs)}).`;
  return note.length > NOTE_MAX_LENGTH ? truncateNote(note, NOTE_MAX_LENGTH) : note;
}

/**
 * Append the repair note to a validated output's `notes` when the stored cap
 * leaves room. A full `notes` array is left untouched — overwriting one of the
 * model's own notes would lose it silently — so callers ALSO log every repair.
 */
export function withFindingsRepairNote<T extends { notes: string[] }>(
  output: T,
  repairs: readonly FindingsRepair[],
): T {
  const note = findingsRepairNote(repairs);
  if (note === undefined || output.notes.length >= NOTES_MAX_COUNT) return output;
  return { ...output, notes: [...output.notes, note] };
}
