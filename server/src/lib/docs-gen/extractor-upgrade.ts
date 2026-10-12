/**
 * #1071 — a code-graph extractor upgrade must not, by itself, regenerate a
 * document.
 *
 * The first ingest after a deploy that changes an extractor rewrites symbol
 * names and edge bindings in place, with no repository change
 * (`code-graph/ingest.ts`, `CODE_GRAPH_EXTRACTOR_VERSION`). A document's input
 * snapshot keys every symbol and edge, so that rewrite moves its fingerprint.
 * Regenerating for it would spend model calls on every auto-updating document
 * for a change nobody made.
 *
 * The rule is narrow, and rests on POSITIVE evidence rather than on what an
 * older record happens to lack:
 *
 *  1. the ingest that rewrites a graph for an upgrade says so on the graph
 *     (`CodeGraph.extractorUpgradedAt`, set only when it upgraded a file);
 *  2. a difference between a document's baseline and its current inputs is put
 *     down to the upgrade only when it is confined to graph rows
 *     ({@link isGraphRowsOnlyChange}) AND a graph the document reads carries a
 *     mark the document has not seen yet — newer than its latest version, and
 *     newer than the last mark acknowledged for that version;
 *  3. it is acknowledged ONCE: the current inputs are recorded beside the
 *     version (`GeneratedDocumentVersion.acknowledgedInputs`) and every later
 *     check compares against them. Nothing is published and no model is
 *     called. The next change of the graph — a lineage backfill, a schema
 *     re-introspection, new rationale findings — differs from the acknowledged
 *     inputs with no new mark, and regenerates.
 *
 * A project whose graph no upgrade rewrote has no mark (or an old one), so
 * every check there behaves exactly as it did before this rule existed.
 */
import { z } from "zod";
import { prisma } from "../prisma.js";
import {
  generationInputSnapshotSchema,
  isGraphRowsOnlyChange,
  type GenerationInputSnapshot,
} from "./regeneration-plan.js";

const acknowledgedInputsSchema = z
  .object({
    /** The `CodeGraph.extractorUpgradedAt` this acknowledgement answers (ISO 8601). */
    upgradedAt: z.string().min(1),
    snapshot: generationInputSnapshotSchema,
  })
  .strict();

/** `GeneratedDocumentVersion.acknowledgedInputs`, parsed. */
export interface AcknowledgedInputs {
  upgradedAt: Date;
  snapshot: GenerationInputSnapshot;
}

/** Null for an absent or unreadable value: the version's own manifest is then the baseline. */
export function parseAcknowledgedInputs(
  stored: string | null | undefined,
): AcknowledgedInputs | null {
  if (!stored) return null;
  try {
    const parsed = acknowledgedInputsSchema.parse(JSON.parse(stored));
    const upgradedAt = new Date(parsed.upgradedAt);
    return Number.isNaN(upgradedAt.getTime()) ? null : { upgradedAt, snapshot: parsed.snapshot };
  } catch {
    return null;
  }
}

export function serializeAcknowledgedInputs(value: AcknowledgedInputs): string {
  return JSON.stringify({ upgradedAt: value.upgradedAt.toISOString(), snapshot: value.snapshot });
}

/**
 * When an extractor upgrade last rewrote a graph in this scope — the same
 * scope `captureGenerationInputs` reads. Null when none ever did.
 */
export async function extractorUpgradeMark(scope: {
  projectId: string;
  codeGraphId?: string | null;
}): Promise<Date | null> {
  const graphs = await prisma.codeGraph.findMany({
    where: { projectId: scope.projectId, ...(scope.codeGraphId ? { id: scope.codeGraphId } : {}) },
    select: { extractorUpgradedAt: true },
  });
  let latest: Date | null = null;
  for (const graph of graphs) {
    const at = graph.extractorUpgradedAt ?? null;
    if (at && (latest === null || at.getTime() > latest.getTime())) latest = at;
  }
  return latest;
}

/**
 * Whether the difference between `baseline` and `current` is an extractor
 * upgrade the holder of `baseline` has not seen: confined to graph rows, with
 * a mark newer than `seen`.
 */
export function isUnseenExtractorUpgrade(
  baseline: GenerationInputSnapshot | null,
  current: GenerationInputSnapshot,
  mark: Date | null,
  seen: Date | null,
): mark is Date {
  if (!mark || !isGraphRowsOnlyChange(baseline, current)) return false;
  return seen === null || mark.getTime() > seen.getTime();
}

/** The latest published version of a document, as far as this rule reads it. */
export interface LatestVersion {
  version: number;
  createdAt: Date;
  acknowledgedInputs?: string | null;
}

export type UpgradeSettlement =
  /** The inputs are the baseline's: nothing to do. */
  | { outcome: "unchanged" }
  /** They differ only by an upgrade seen now for the first time: recorded, nothing to regenerate. */
  | { outcome: "acknowledged" }
  /** They differ for another reason (or by an upgrade already acknowledged): regenerate. */
  | { outcome: "changed" };

/**
 * Compare a document's current inputs with what its latest version is known
 * to stand for — the inputs acknowledged for it, else its manifest's — and
 * acknowledge an extractor upgrade seen for the first time.
 *
 * @param published the latest version's manifest snapshot (null: none recorded).
 */
export async function settleExtractorUpgrade(args: {
  documentId: string;
  scope: { projectId: string; codeGraphId?: string | null };
  latest: LatestVersion | null;
  published: GenerationInputSnapshot | null;
  current: GenerationInputSnapshot;
}): Promise<UpgradeSettlement> {
  const { latest, published, current } = args;
  const acknowledged = parseAcknowledgedInputs(latest?.acknowledgedInputs);
  const baseline = acknowledged?.snapshot ?? published;
  if (baseline?.fingerprint === current.fingerprint) return { outcome: "unchanged" };
  // Without a published version there is nothing an upgrade could be told from.
  if (!latest || !baseline || !isGraphRowsOnlyChange(baseline, current)) {
    return { outcome: "changed" };
  }
  const mark = await extractorUpgradeMark(args.scope);
  const seen = acknowledged?.upgradedAt ?? latest.createdAt;
  if (!isUnseenExtractorUpgrade(baseline, current, mark, seen)) return { outcome: "changed" };
  await prisma.generatedDocumentVersion.updateMany({
    where: { documentId: args.documentId, version: latest.version },
    data: {
      acknowledgedInputs: serializeAcknowledgedInputs({ upgradedAt: mark, snapshot: current }),
    },
  });
  return { outcome: "acknowledged" };
}
