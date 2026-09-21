/**
 * #1370 — idempotent backfill for leaked grounding markers.
 *
 * {@link stripLeakedSourceIds} runs at generation assembly, so it is
 * forward-only: every document generated BEFORE the fix keeps its markers, and
 * so do the `KnowledgeChunk` rows cut from those documents. Those chunks are the
 * ones fed back to the model as grounding context on every chat turn, which is
 * why cleaning the documents alone is not enough — measured at 1,408 `[facts:…]`
 * plus 315 `[rag:…]` markers live in the retrieval corpus.
 *
 * Idempotent by construction: a row is written only when stripping actually
 * changes its text, so a second run is a no-op and reports zero updates.
 *
 * Structural citation is untouched. `sourceIds`, the provenance manifest and the
 * UI "Sources:" list are separate columns/relations; only the free-text
 * `content` / `text` bodies are rewritten.
 */
import { createHash } from "node:crypto";
import { stripLeakedSourceIds } from "./holistic-synthesizer.js";

/** Minimal Prisma surface, so the backfill is unit-testable without a database. */
export interface LeakedMarkerBackfillPrisma {
  generatedDocument: {
    findMany: (args: unknown) => Promise<Array<{ id: string; content: string }>>;
    update: (args: { where: { id: string }; data: { content: string } }) => Promise<{ id: string }>;
  };
  knowledgeChunk: {
    findMany: (args: unknown) => Promise<Array<{ id: string; text: string }>>;
    update: (args: {
      where: { id: string };
      data: { text: string; md5: string };
    }) => Promise<{ id: string }>;
  };
}

export interface BackfillOptions {
  /** Report what would change without writing. Default false. */
  dryRun?: boolean;
  /** Rows read per page. Default 500. */
  batchSize?: number;
  /** Restrict to one project. Omit to sweep every project. */
  projectId?: string;
}

export interface BackfillReport {
  documentsScanned: number;
  documentsUpdated: number;
  chunksScanned: number;
  chunksUpdated: number;
  /** Markers removed across both tables — the number the issue's table counts. */
  markersRemoved: number;
  dryRun: boolean;
}

const DEFAULT_BATCH_SIZE = 500;

/** How many markers stripping removed from this string. */
function markerDelta(before: string, after: string): number {
  if (before === after) return 0;
  // Each marker is one `[prefix:…]` bracket; count them on the original.
  return (before.match(/\[\s*(?:facts|rag):[^\]\n]*\]/g) ?? []).length;
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/**
 * Strip leaked markers from every stored generated document and knowledge chunk.
 *
 * Paginates by OFFSET, and the offset advances only past rows left UNCHANGED.
 * Cursor pagination would be wrong here: each write removes its row from the
 * very `contains` predicate the page was selected by, so on the next query the
 * cursor row is no longer in the filtered set and the position is undefined.
 * Counting skipped no-ops instead makes progress every iteration — either a row
 * leaves the filter or the offset steps past it — so the loop terminates.
 *
 * Filtering happens in the database so a clean corpus costs two empty queries
 * rather than a full table scan in Node.
 */
export async function backfillLeakedMarkers(
  prisma: LeakedMarkerBackfillPrisma,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const projectFilter = options.projectId ? { projectId: options.projectId } : {};
  const report: BackfillReport = {
    documentsScanned: 0,
    documentsUpdated: 0,
    chunksScanned: 0,
    chunksUpdated: 0,
    markersRemoved: 0,
    dryRun,
  };

  // ── Generated documents ────────────────────────────────────────────────
  let skip = 0;
  for (;;) {
    const rows = await prisma.generatedDocument.findMany({
      where: {
        ...projectFilter,
        deletedAt: null,
        OR: [{ content: { contains: "[facts:" } }, { content: { contains: "[rag:" } }],
      },
      select: { id: true, content: true },
      orderBy: { id: "asc" },
      take: batchSize,
      skip,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      report.documentsScanned += 1;
      const cleaned = stripLeakedSourceIds(row.content);
      if (cleaned === row.content) {
        // Matched the `contains` filter but has nothing to rewrite — a marker
        // that only appears inside a fence. Step past it.
        skip += 1;
        continue;
      }
      report.documentsUpdated += 1;
      report.markersRemoved += markerDelta(row.content, cleaned);
      if (dryRun) {
        skip += 1;
        continue;
      }
      await prisma.generatedDocument.update({
        where: { id: row.id },
        data: { content: cleaned },
      });
    }
  }

  // ── Knowledge chunks ───────────────────────────────────────────────────
  skip = 0;
  for (;;) {
    const rows = await prisma.knowledgeChunk.findMany({
      where: {
        ...projectFilter,
        OR: [{ text: { contains: "[facts:" } }, { text: { contains: "[rag:" } }],
      },
      select: { id: true, text: true },
      orderBy: { id: "asc" },
      take: batchSize,
      skip,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      report.chunksScanned += 1;
      const cleaned = stripLeakedSourceIds(row.text);
      if (cleaned === row.text) {
        skip += 1;
        continue;
      }
      report.chunksUpdated += 1;
      report.markersRemoved += markerDelta(row.text, cleaned);
      if (dryRun) {
        skip += 1;
        continue;
      }
      // md5 is the chunk's content hash — rewriting text without it would
      // leave dedupe/quarantine comparing against a hash of deleted markers.
      await prisma.knowledgeChunk.update({
        where: { id: row.id },
        data: { text: cleaned, md5: md5(cleaned) },
      });
    }
  }

  return report;
}
