/**
 * Issue #1202 — the pairing promotion makes between an approved STRUCTURED
 * requirement (`REQ-3`) and the `Requirement` row written from it.
 *
 * Promotion (#730) knows which structured requirement each row is, and which
 * synthesis items gave it criteria and evidence (#1033). Before #1202 it kept
 * only the structured ids, so every later step that needed the link matched
 * titles again, and neighbouring requirements whose bodies use each other's
 * title words defeated that (#1031, #1033). The pairing is now recorded on the
 * row itself (`promotedStructuredId`, `promotedStructuredRunId`,
 * `promotedSynthesisKeys`), so a re-run's hard delete of the rows (#57) takes
 * it with them, and clarification attribution and the synthesis join look it
 * up. Rows promoted before #1202 carry NULL and keep the title matching.
 *
 * Pure: no database access, so every promotion writer and both joins share it.
 */
import { createHash } from "node:crypto";

/** The two fields of a synthesis item that identify it. */
interface SynthesisItemIdentity {
  title: string;
  body: string;
}

/**
 * A synthesis item's identity across reads of the same output: its title and
 * body, hashed. A row records the keys of the items it took, so a later join
 * finds them without matching titles; an output whose items changed (synthesis
 * re-ran) simply has no item with that key, and the join falls back.
 */
export function synthesisItemKey(item: SynthesisItemIdentity): string {
  return createHash("sha256").update(`${item.title}\n${item.body}`).digest("hex").slice(0, 32);
}

/**
 * Structured id → the synthesis items (indexes into the output being joined)
 * its promoted row already took. An empty list is a row that took none.
 */
export type PairedItems = ReadonlyMap<string, readonly number[]>;

/** A row's recorded pairing, as the `requirements` columns hold it. */
export interface RecordedPairing {
  promotedStructuredId: string | null;
  promotedStructuredRunId: string | null;
  promotedSynthesisKeys?: string | null;
}

/**
 * Whether a row's pairing belongs to the structured list being joined: the
 * extraction run must be the same one, because every run numbers its list from
 * `REQ-001` (#909). A list written before #909 has no run id, and a row
 * promoted from it records none, so the two compare equal.
 */
export function pairedInRun(row: RecordedPairing, runId: string | null | undefined): boolean {
  return (
    Boolean(row.promotedStructuredId) && (row.promotedStructuredRunId ?? null) === (runId ?? null)
  );
}

/**
 * The pairings recorded for the extraction run `runId`, resolved against the
 * synthesis output being joined: structured id → the item indexes the row took.
 * A row promoted before #1202, from another run, or whose recorded items are
 * not all in this output is left out, and its requirement is joined as before.
 */
export function pairedItemIndexes(
  rows: readonly RecordedPairing[],
  runId: string | null | undefined,
  synthesized: readonly SynthesisItemIdentity[],
): Map<string, number[]> {
  const indexByKey = new Map<string, number>();
  synthesized.forEach((s, i) => {
    const key = synthesisItemKey(s);
    if (!indexByKey.has(key)) indexByKey.set(key, i);
  });
  const out = new Map<string, number[]>();
  for (const row of rows) {
    if (!pairedInRun(row, runId)) continue;
    const keys = parseKeys(row.promotedSynthesisKeys ?? null);
    if (!keys) continue;
    const indexes = keys.map((k) => indexByKey.get(k));
    if (indexes.some((i) => i === undefined)) continue;
    out.set(row.promotedStructuredId!, indexes as number[]);
  }
  return out;
}

function parseKeys(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((k) => typeof k === "string")
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/** What one promoted row records about where it came from. */
export interface PromotionPairing {
  structuredId: string;
  synthesisKeys: readonly string[];
}

/**
 * The pairing a promotion writer records on the rows it inserts: `pairings[i]`
 * is the structured requirement the i-th persisted requirement was written
 * from, and `runId` the extraction run those ids belong to.
 */
export interface PromotedFrom {
  runId: string | null;
  pairings: ReadonlyArray<PromotionPairing>;
}

/**
 * The pairing columns the `idx`-th promoted row is written with. Empty when
 * there is no pairing for the row, which leaves the columns NULL.
 */
export function pairingColumns(
  promotedFrom: PromotedFrom | undefined,
  idx: number,
): {
  promotedStructuredId?: string;
  promotedStructuredRunId?: string | null;
  promotedSynthesisKeys?: string;
} {
  const pairing = promotedFrom?.pairings[idx];
  if (!promotedFrom || !pairing) return {};
  return {
    promotedStructuredId: pairing.structuredId,
    promotedStructuredRunId: promotedFrom.runId,
    promotedSynthesisKeys: JSON.stringify(pairing.synthesisKeys),
  };
}
