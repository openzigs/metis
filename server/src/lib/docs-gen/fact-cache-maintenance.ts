/**
 * #156 — purge Phase-1 fact-cache rows whose extraction was cut off by the
 * output-token cap.
 *
 * Before #156 a truncated Phase-1 reply was cached like any other, so every
 * later run reused the incomplete facts (12 of onyourleft's 143 rows sat at
 * exactly gemma3:12b's 8,192-token cap). New runs no longer cache a truncated
 * reply; this cleans the rows already written. A row cannot say which cap it
 * was produced under, so "truncated" is `outputTokens >= minOutputTokens`.
 *
 * By default only rows from an OLDER Phase-1 prompt version are swept. Since
 * #156 the only current-version row that can reach the cap is a successful
 * larger-cap retry, which is complete — deleting it would just pay for the
 * extraction again. `includeCurrentVersion` widens the sweep for a provider
 * that reports no finish reason (a truncated reply it produced can still have
 * been cached as complete).
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
  promptVersion?: { lt: number };
  projectId?: string;
}

export interface PurgeTruncatedFactsOptions {
  /** The running Phase-1 prompt version (`PHASE1_PROMPT_VERSION`). */
  currentPromptVersion: number;
  /**
   * Also sweep rows written under the current prompt version. Default false —
   * see the module header.
   */
  includeCurrentVersion?: boolean;
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
  includeCurrentVersion: boolean;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/** Delete (or, with `dryRun`, count) the fact-cache rows that hit the output cap. */
export async function purgeTruncatedFactCache(
  db: FactCachePurgePrisma,
  options: PurgeTruncatedFactsOptions,
): Promise<PurgeTruncatedFactsReport> {
  const minOutputTokens = options.minOutputTokens ?? DEFAULT_FACTS_MAX_OUTPUT_TOKENS;
  assertPositiveInteger("minOutputTokens", minOutputTokens);
  assertPositiveInteger("currentPromptVersion", options.currentPromptVersion);
  const dryRun = options.dryRun ?? false;
  const includeCurrentVersion = options.includeCurrentVersion ?? false;
  const where: TruncatedRowWhere = {
    outputTokens: { gte: minOutputTokens },
    ...(includeCurrentVersion ? {} : { promptVersion: { lt: options.currentPromptVersion } }),
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
  if (dryRun) {
    const matched = await db.docsGenFactCache.count({ where });
    return { matched, deleted: 0, minOutputTokens, dryRun, includeCurrentVersion };
  }
  const { count } = await db.docsGenFactCache.deleteMany({ where });
  return { matched: count, deleted: count, minOutputTokens, dryRun, includeCurrentVersion };
}

/** The CLI options of `facts:purge-truncated`, minus the prompt version the script supplies. */
export type PurgeArgs = Omit<PurgeTruncatedFactsOptions, "currentPromptVersion">;

/**
 * Parse `facts:purge-truncated` arguments. A value flag with no value (end of
 * argv, empty, or followed by another `--flag`) is an error, never "unset": a
 * bare `--project` silently becoming "every project" would widen a destructive
 * purge. Unknown arguments are rejected for the same reason (a typo such as
 * `--projct p1` would otherwise sweep every project).
 */
export function parsePurgeArgs(argv: readonly string[]): PurgeArgs {
  const out: PurgeArgs = { dryRun: false, includeCurrentVersion: false };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--include-current") out.includeCurrentVersion = true;
    else if (arg === "--project") out.projectId = valueOf(i++, arg);
    else if (arg === "--min-output-tokens") out.minOutputTokens = Number(valueOf(i++, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}
