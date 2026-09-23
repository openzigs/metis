/**
 * #156 — purge Phase-1 fact-cache rows whose extraction was cut off by the
 * output-token cap.
 *
 * Before #156 a truncated Phase-1 reply was cached like any other, so every
 * later run reused the incomplete facts (12 of onyourleft's 143 rows sat at
 * exactly gemma3:12b's 8,192-token cap). New runs no longer cache a truncated
 * reply; this cleans the rows already written. A row cannot say which cap it
 * was produced under, so "truncated" is `outputTokens >= minOutputTokens` — a
 * complete row that happens to reach the threshold is only re-extracted on the
 * next run, which costs one LLM call and loses nothing.
 */
import { DEFAULT_FACTS_MAX_OUTPUT_TOKENS } from "./output-caps.js";

/** Minimal Prisma surface, so the purge is unit-testable without a database. */
export interface FactCachePurgePrisma {
  docsGenFactCache: {
    count: (args: { where: TruncatedRowWhere }) => Promise<number>;
    deleteMany: (args: { where: TruncatedRowWhere }) => Promise<{ count: number }>;
  };
}

interface TruncatedRowWhere {
  outputTokens: { gte: number };
  projectId?: string;
}

export interface PurgeTruncatedFactsOptions {
  /**
   * Rows with at least this many output tokens are treated as truncated.
   * Default {@link DEFAULT_FACTS_MAX_OUTPUT_TOKENS} — the Phase-1 cap every row
   * was produced under unless an operator raised `DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS`.
   */
  minOutputTokens?: number;
  /** Restrict to one project. Omit to sweep every project. */
  projectId?: string;
  /** Count what would be deleted without deleting. Default false. */
  dryRun?: boolean;
}

export interface PurgeTruncatedFactsReport {
  /** Rows matched (deleted, unless `dryRun`). */
  matched: number;
  deleted: number;
  minOutputTokens: number;
  dryRun: boolean;
}

/** Delete (or, with `dryRun`, count) the fact-cache rows that hit the output cap. */
export async function purgeTruncatedFactCache(
  db: FactCachePurgePrisma,
  options: PurgeTruncatedFactsOptions = {},
): Promise<PurgeTruncatedFactsReport> {
  const minOutputTokens = options.minOutputTokens ?? DEFAULT_FACTS_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(minOutputTokens) || minOutputTokens < 1) {
    throw new Error(`minOutputTokens must be a positive integer, got ${String(minOutputTokens)}`);
  }
  const dryRun = options.dryRun ?? false;
  const where: TruncatedRowWhere = {
    outputTokens: { gte: minOutputTokens },
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
  if (dryRun) {
    const matched = await db.docsGenFactCache.count({ where });
    return { matched, deleted: 0, minOutputTokens, dryRun };
  }
  const { count } = await db.docsGenFactCache.deleteMany({ where });
  return { matched: count, deleted: count, minOutputTokens, dryRun };
}
