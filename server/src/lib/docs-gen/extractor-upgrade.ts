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
 *  1. the ingest that rewrites a graph for an upgrade says so on the graph:
 *     `CodeGraph.extractorUpgradedAt` moves with every write of the rewrite,
 *     and only then;
 *  2. a difference between a document's baseline and its current inputs is put
 *     down to the upgrade only when it is confined to graph rows
 *     ({@link isGraphRowsOnlyChange}) AND a graph the document reads carries a
 *     mark the document has not seen yet — newer than its latest version, and
 *     newer than the last mark acknowledged for that version;
 *  3. it is acknowledged ONCE: the fingerprint of the current inputs is
 *     recorded for the document (`GeneratedDocumentAcknowledgement`) and every
 *     later check treats it as a baseline beside the version's own manifest.
 *     Nothing is published and no model is called. The next change of the
 *     graph — a lineage backfill, a schema re-introspection, new rationale
 *     findings — matches neither baseline and has no new mark, so it
 *     regenerates.
 *
 * A project whose graph no upgrade rewrote has no mark, so every check there
 * behaves exactly as it did before this rule existed — and reads nothing more:
 * the acknowledgement and the mark are looked up only for a difference that is
 * confined to graph rows.
 */
import { prisma } from "../prisma.js";
import { isGraphRowsOnlyChange, type GenerationInputSnapshot } from "./regeneration-plan.js";

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
 * Whether `mark` is an upgrade its reader has not seen yet: there is one, and
 * it is newer than `seen`. This is only the evidence THAT an upgrade rewrote
 * the graph; the caller has already established that the difference it is
 * looking at is confined to graph rows ({@link isGraphRowsOnlyChange}).
 */
export function isUnseenUpgradeMark(mark: Date | null, seen: Date): mark is Date {
  return mark !== null && mark.getTime() > seen.getTime();
}

/** The latest published version of a document, as far as this rule reads it. */
export interface LatestVersion {
  version: number;
  createdAt: Date;
}

/** What a run that an upgrade overtook stands for when it publishes. */
export interface AcknowledgedUpgrade {
  upgradedAt: Date;
  snapshot: GenerationInputSnapshot;
}

/**
 * Record, for a document, the inputs its version `version` is acknowledged to
 * stand for. One row per document: a later acknowledgement replaces it, and a
 * row left behind by an older version is ignored by {@link settleExtractorUpgrade}.
 */
export async function acknowledgeExtractorUpgrade(
  db: Pick<typeof prisma, "generatedDocumentAcknowledgement">,
  documentId: string,
  version: number,
  upgrade: { upgradedAt: Date; fingerprint: string },
): Promise<void> {
  const data = { version, upgradedAt: upgrade.upgradedAt, fingerprint: upgrade.fingerprint };
  await db.generatedDocumentAcknowledgement.upsert({
    where: { documentId },
    create: { documentId, ...data },
    update: data,
  });
}

export type UpgradeSettlement =
  /** The inputs are the published or the acknowledged ones: nothing to do. */
  | { outcome: "unchanged" }
  /** They differ only by an upgrade seen now for the first time: recorded, nothing to regenerate. */
  | { outcome: "acknowledged" }
  /** They differ for another reason (or by an upgrade already acknowledged): regenerate. */
  | { outcome: "changed" };

/**
 * Compare a document's current inputs with what its latest version is known
 * to stand for — its manifest's inputs, or the ones acknowledged for it — and
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
  if (published?.fingerprint === current.fingerprint) return { outcome: "unchanged" };
  // Anything but a difference confined to graph rows is a change, whatever was
  // acknowledged: an acknowledgement only ever covers graph rows. Without a
  // published version there is nothing an upgrade could be told from.
  if (!latest || !isGraphRowsOnlyChange(published, current)) return { outcome: "changed" };
  const row = await prisma.generatedDocumentAcknowledgement.findUnique({
    where: { documentId: args.documentId },
  });
  const acknowledged = row && row.version === latest.version ? row : null;
  if (acknowledged?.fingerprint === current.fingerprint) return { outcome: "unchanged" };
  const mark = await extractorUpgradeMark(args.scope);
  const seen = acknowledged?.upgradedAt ?? latest.createdAt;
  if (!isUnseenUpgradeMark(mark, seen)) return { outcome: "changed" };
  await acknowledgeExtractorUpgrade(prisma, args.documentId, latest.version, {
    upgradedAt: mark,
    fingerprint: current.fingerprint,
  });
  return { outcome: "acknowledged" };
}
