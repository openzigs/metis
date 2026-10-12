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
 * The rule is narrow, and rests on POSITIVE evidence, per graph:
 *
 *  1. the ingest that rewrites a graph for an upgrade says so on THAT graph:
 *     `CodeGraph.extractorUpgradedAt` (its "mark") moves with every write of
 *     the rewrite, and only then;
 *  2. a snapshot of a document's inputs records, for each graph the document
 *     reads, a digest of the items derived from that graph's rows and the mark
 *     the graph carried when it was captured (`GenerationInputSnapshot.graphs`);
 *  3. a difference between a document's baseline and its current inputs is put
 *     down to an upgrade only when it is confined to graph rows
 *     ({@link isGraphRowsOnlyChange}) AND every graph whose rows differ carries
 *     a mark that is not the one the baseline recorded for that same graph
 *     ({@link isAttributableToUpgrade}). A difference in the rows of a graph
 *     whose mark did not move is a real change and regenerates — whatever
 *     happened to the project's other graphs in the same refresh;
 *  4. it is acknowledged ONCE: the current inputs — fingerprint, per-graph
 *     digests and marks — are recorded for the document
 *     (`GeneratedDocumentAcknowledgement`) and are the baseline of every later
 *     check. Nothing is published and no model is called. The next change of a
 *     graph — a lineage backfill, a schema re-introspection, new rationale
 *     findings — finds that graph's mark where the baseline left it, so it
 *     regenerates.
 *
 * ## One clock, and no ordering
 *
 * A mark is only ever compared with another mark OF THE SAME GRAPH, for
 * identity: "is this the mark the baseline saw". It is never compared with a
 * version's `createdAt`, with `now`, or with another graph's mark, so no skew
 * between the ingest writer, the database and the generating process can make
 * the rule acknowledge. Skew cannot make a mark look new: only a write of an
 * upgrade moves it.
 *
 * A mark that moved while the document's inputs did NOT differ (the upgrade
 * rewrote nothing this document reads) is adopted as seen at the next check,
 * so it is never evidence for a later, unrelated change.
 *
 * ## What an older record does
 *
 * A baseline written before per-graph attribution existed has no `graphs`
 * (every manifest published before #1071 shipped). Its difference cannot be
 * attributed to a graph, and no mark was recorded for it. It is put down to an
 * upgrade only when EVERY graph the document reads carries a mark: then every
 * differing row is in a graph an upgrade rewrote, and — the mark being
 * introduced by the same release as this rule — after that version was
 * published. A document over two graphs of which one was not upgraded (no Go
 * files) regenerates instead, once: its new version records `graphs`. A
 * single-graph document never pays that. A legacy baseline whose inputs did
 * not differ adopts the marks like any other.
 *
 * ## Known limit
 *
 * Attribution is per GRAPH, not per row. When the same ingest that upgrades a
 * graph also changes that graph's rows for another reason — a lineage backfill
 * that runs with it, a re-introspection just before — the two cannot be told
 * apart, and both are acknowledged with the upgrade. That is bounded, and only
 * for a change confined to graph rows of the upgraded graph: a change to any
 * source file, SQL file, evidence or setting always regenerates.
 *
 * The bound is once per upgrade per document when the upgrade completes in
 * one ingest. When the Go binding of an upgrade is interrupted by its time
 * ceiling, the ingests that finish it move the mark again — once each, and
 * only when they write a call the upgrade itself left unresolved; no other
 * re-bind of an unstamped graph moves it (`ingest.ts`, pass 3). There are at
 * most ⌈open calls / `GO_BINDING_MIN_CALLS`⌉ + `GO_BINDING_RESUME_GRACE` such
 * ingests, after which the remainder is given up and the version stamped. On
 * a graph that was ALREADY stamped, a later ceiling moves no mark at all: the
 * rows a resume improves there read as the real change they are.
 *
 * A project whose graph no upgrade rewrote has no mark, so every check there
 * behaves exactly as it did before this rule existed — and reads nothing more:
 * the acknowledgement is looked up only when the inputs differ in graph rows
 * alone, or a mark is not the one the published version recorded.
 */
import { prisma } from "../prisma.js";
import {
  graphStatesSchema,
  isGraphRowsOnlyChange,
  type GenerationInputSnapshot,
  type GraphStates,
} from "./regeneration-plan.js";

/**
 * Whether the graph-row difference between `base` and `current` is confined to
 * graphs an extractor upgrade rewrote since `base` was recorded.
 *
 * The caller has established that the two differ only in graph rows. Every
 * graph whose rows differ must be in both, and carry a mark now that is not
 * the mark `base` recorded for it. A graph that appeared or went, rows that
 * differ under an unmoved mark, or no differing graph at all (nothing to
 * attribute) is not an upgrade.
 *
 * @param base undefined for a baseline recorded before per-graph attribution:
 *   see "What an older record does" in the file header.
 */
export function isAttributableToUpgrade(
  base: GraphStates | undefined,
  current: GraphStates | undefined,
): boolean {
  if (!current) return false;
  const now = Object.entries(current);
  if (!base) return now.length > 0 && now.every(([, graph]) => graph.mark !== null);
  let differing = 0;
  for (const tag of new Set([...Object.keys(base), ...Object.keys(current)])) {
    const was = base[tag];
    const is = current[tag];
    if (was && is && was.rows === is.rows) continue;
    if (!was || !is || is.mark === null || is.mark === was.mark) return false;
    differing += 1;
  }
  return differing > 0;
}

/** True when a graph of `current` carries another mark than `base` recorded for it (or `base` recorded none). */
export function hasUnrecordedMark(
  base: GraphStates | undefined,
  current: GraphStates | undefined,
): boolean {
  if (!current) return false;
  return Object.entries(current).some(([tag, graph]) =>
    base
      ? base[tag]?.mark !== graph.mark && (graph.mark !== null || tag in base)
      : graph.mark !== null,
  );
}

/** The latest mark among `graphs`; the epoch when none carries one. */
function latestMark(graphs: GraphStates | undefined): Date {
  let latest = 0;
  for (const graph of Object.values(graphs ?? {})) {
    if (graph.mark) latest = Math.max(latest, new Date(graph.mark).getTime());
  }
  return new Date(latest);
}

/** The latest published version of a document, as far as this rule reads it. */
export interface LatestVersion {
  version: number;
}

/** What a run that an upgrade overtook stands for when it publishes. */
export interface AcknowledgedUpgrade {
  snapshot: GenerationInputSnapshot;
}

/** `GeneratedDocumentAcknowledgement.graphs` as states; anything unreadable is "none recorded". */
function parseGraphStates(stored: string | null | undefined): GraphStates | undefined {
  if (!stored) return undefined;
  try {
    const parsed = graphStatesSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record, for a document, the inputs its version `version` is acknowledged to
 * stand for: their fingerprint, and each graph's row digest and mark. One row
 * per document: a later acknowledgement replaces it, and a row left behind by
 * an older version is ignored by {@link settleExtractorUpgrade}.
 */
export async function acknowledgeExtractorUpgrade(
  db: Pick<typeof prisma, "generatedDocumentAcknowledgement">,
  documentId: string,
  version: number,
  snapshot: Pick<GenerationInputSnapshot, "fingerprint" | "graphs">,
): Promise<void> {
  const data = {
    version,
    upgradedAt: latestMark(snapshot.graphs),
    fingerprint: snapshot.fingerprint,
    graphs: snapshot.graphs ? JSON.stringify(snapshot.graphs) : null,
  };
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
  latest: LatestVersion | null;
  published: GenerationInputSnapshot | null;
  current: GenerationInputSnapshot;
}): Promise<UpgradeSettlement> {
  const { latest, published, current } = args;
  // Without a published version and its inputs there is nothing an upgrade
  // could be told from.
  if (!latest || !published) return { outcome: "changed" };
  const same = published.fingerprint === current.fingerprint;
  // Anything but a difference confined to graph rows is a change, whatever was
  // acknowledged: an acknowledgement only ever covers graph rows.
  if (!same && !isGraphRowsOnlyChange(published, current)) return { outcome: "changed" };
  // The published inputs, under the marks they were published with: nothing to read.
  if (same && !hasUnrecordedMark(published.graphs, current.graphs)) return { outcome: "unchanged" };
  const row = await prisma.generatedDocumentAcknowledgement.findUnique({
    where: { documentId: args.documentId },
  });
  const acknowledged = row && row.version === latest.version ? row : null;
  const base = acknowledged
    ? { fingerprint: acknowledged.fingerprint, graphs: parseGraphStates(acknowledged.graphs) }
    : published;
  const adopt = (): Promise<void> =>
    acknowledgeExtractorUpgrade(prisma, args.documentId, latest.version, current);
  if (same || base.fingerprint === current.fingerprint) {
    // Inputs the version already stands for. A mark that moved without moving
    // them is recorded as seen, so it is never evidence for a later change.
    if (
      base.fingerprint !== current.fingerprint ||
      hasUnrecordedMark(base.graphs, current.graphs)
    ) {
      await adopt();
    }
    return { outcome: "unchanged" };
  }
  // An acknowledgement that recorded no graphs (unreadable, or written before
  // they were kept) attributes nothing: only a PUBLISHED baseline is "older".
  if (acknowledged && !base.graphs) return { outcome: "changed" };
  if (!isAttributableToUpgrade(base.graphs, current.graphs)) return { outcome: "changed" };
  await adopt();
  return { outcome: "acknowledged" };
}
