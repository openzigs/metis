/**
 * Epic #596 / Issue #616 — AST Summary Cache.
 *
 * Parses source files into ASTs, generates per-function/class summaries,
 * and caches them for fast retrieval. Supports cache invalidation based on
 * file modification timestamps. Summary generation can optionally use an
 * LLM (Haiku) for richer descriptions, but falls back to signature-based
 * summaries when no provider is available.
 *
 * Endpoints:
 *   POST /api/projects/:projectId/repositories/:repoId/rebuild-cache
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createChildLogger } from "../logger.js";
import { parseSource, summarizeNode, detectLanguage, type ASTNode } from "./ast-parser.js";

const log = createChildLogger("ast-summary-cache");

export interface CachedSummary {
  filePath: string;
  symbol: string;
  kind: string;
  signature: string;
  summary: string;
  startLine: number;
  endLine: number;
  /** ISO timestamp when this entry was cached. */
  cachedAt: string;
  /** Hash of the source at cache time for invalidation. */
  sourceHash: string;
}

export interface CacheLookupResult {
  hit: boolean;
  summaries: CachedSummary[];
  /** True when full-file read was required because cache was empty/stale. */
  fallthrough: boolean;
}

export interface ASTSummaryCacheOptions {
  /** Maximum entries per file. Default: 100. */
  maxEntriesPerFile?: number;
  /** Optional LLM summarization function. If not provided, uses signature-based summaries. */
  summarize?: (source: string, signature: string) => Promise<string>;
}

/**
 * Simple hash using built-in crypto for cache invalidation.
 */
async function hashSource(source: string): Promise<string> {
  // Use a simple fast hash — no need for crypto strength
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

export class ASTSummaryCache {
  private readonly cache = new Map<string, CachedSummary[]>();
  private readonly sourceHashes = new Map<string, string>();
  private readonly opts: Required<ASTSummaryCacheOptions>;
  private fallthroughCount = 0;
  private lookupCount = 0;

  constructor(opts: ASTSummaryCacheOptions = {}) {
    this.opts = {
      maxEntriesPerFile: opts.maxEntriesPerFile ?? 100,
      summarize: opts.summarize ?? (async (_src, sig) => sig),
    };
  }

  /**
   * Look up cached summaries for a file. Returns a cache miss if the file
   * hasn't been parsed or has been modified since last parse.
   */
  async lookup(filePath: string, currentSource?: string): Promise<CacheLookupResult> {
    this.lookupCount++;
    const cached = this.cache.get(filePath);

    if (!cached || cached.length === 0) {
      this.fallthroughCount++;
      return { hit: false, summaries: [], fallthrough: true };
    }

    // Check staleness if current source is provided
    if (currentSource) {
      const currentHash = await hashSource(currentSource);
      const cachedHash = this.sourceHashes.get(filePath);
      if (cachedHash !== currentHash) {
        this.fallthroughCount++;
        return { hit: false, summaries: [], fallthrough: true };
      }
    }

    return { hit: true, summaries: cached, fallthrough: false };
  }

  /**
   * Parse and cache summaries for a single file.
   */
  async indexFile(filePath: string, source: string): Promise<CachedSummary[]> {
    const lang = detectLanguage(filePath);
    if (!lang) {
      log.debug("unsupported language, skipping", { filePath });
      return [];
    }

    const result = parseSource(filePath, source);
    if (!result || result.nodes.length === 0) return [];

    const hash = await hashSource(source);
    const now = new Date().toISOString();
    const summaries: CachedSummary[] = [];

    for (const node of result.nodes.slice(0, this.opts.maxEntriesPerFile)) {
      const summary = await this.generateSummary(node);
      summaries.push({
        filePath,
        symbol: node.name,
        kind: node.kind,
        signature: node.signature,
        summary,
        startLine: node.startLine,
        endLine: node.endLine,
        cachedAt: now,
        sourceHash: hash,
      });

      // Also index class children
      for (const child of node.children) {
        const childSummary = await this.generateSummary(child);
        summaries.push({
          filePath: filePath,
          symbol: `${node.name}.${child.name}`,
          kind: child.kind,
          signature: child.signature,
          summary: childSummary,
          startLine: child.startLine,
          endLine: child.endLine,
          cachedAt: now,
          sourceHash: hash,
        });
      }
    }

    this.cache.set(filePath, summaries);
    this.sourceHashes.set(filePath, hash);
    log.debug("indexed file", { filePath, count: summaries.length });
    return summaries;
  }

  /**
   * Rebuild the cache for an entire repository by indexing a batch of files.
   */
  async rebuildForFiles(
    files: Array<{ path: string; content: string }>,
  ): Promise<{ indexed: number; skipped: number; totalSymbols: number }> {
    let indexed = 0;
    let skipped = 0;
    let totalSymbols = 0;

    for (const file of files) {
      if (!detectLanguage(file.path)) {
        skipped++;
        continue;
      }
      const summaries = await this.indexFile(file.path, file.content);
      if (summaries.length > 0) {
        indexed++;
        totalSymbols += summaries.length;
      } else {
        skipped++;
      }
    }

    log.info("cache rebuild complete", { indexed, skipped, totalSymbols });
    return { indexed, skipped, totalSymbols };
  }

  /**
   * Invalidate cache entries for files that have changed (e.g. from git diff).
   */
  invalidate(filePaths: string[]): number {
    let invalidated = 0;
    for (const fp of filePaths) {
      if (this.cache.delete(fp)) {
        this.sourceHashes.delete(fp);
        invalidated++;
      }
    }
    if (invalidated > 0) {
      log.info("cache entries invalidated", { invalidated });
    }
    return invalidated;
  }

  /**
   * Search cached summaries by symbol name or keyword.
   */
  search(query: string, limit = 20): CachedSummary[] {
    const q = query.toLowerCase();
    const results: CachedSummary[] = [];

    for (const entries of this.cache.values()) {
      for (const entry of entries) {
        if (
          entry.symbol.toLowerCase().includes(q) ||
          entry.summary.toLowerCase().includes(q) ||
          entry.signature.toLowerCase().includes(q)
        ) {
          results.push(entry);
          if (results.length >= limit) return results;
        }
      }
    }

    return results;
  }

  /**
   * Return the fallthrough rate: fraction of lookups that required full-file reads.
   */
  get fallthroughRate(): number {
    if (this.lookupCount === 0) return 0;
    return this.fallthroughCount / this.lookupCount;
  }

  /** Total cached files. */
  get size(): number {
    return this.cache.size;
  }

  /** Get all summaries for a file. */
  getFileSummaries(filePath: string): CachedSummary[] {
    return this.cache.get(filePath) ?? [];
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
    this.sourceHashes.clear();
    this.fallthroughCount = 0;
    this.lookupCount = 0;
  }

  /** Get cache statistics. */
  get stats(): {
    totalFiles: number;
    totalSymbols: number;
    lookups: number;
    fallthroughs: number;
    fallthroughRate: number;
  } {
    let totalSymbols = 0;
    for (const entries of this.cache.values()) {
      totalSymbols += entries.length;
    }
    return {
      totalFiles: this.cache.size,
      totalSymbols,
      lookups: this.lookupCount,
      fallthroughs: this.fallthroughCount,
      fallthroughRate: this.fallthroughRate,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async generateSummary(node: ASTNode): Promise<string> {
    const signatureSummary = summarizeNode(node);
    try {
      return await this.opts.summarize(node.source, signatureSummary);
    } catch {
      // Fallback to signature-based summary on LLM failure
      return signatureSummary;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let singleton: ASTSummaryCache | null = null;

export function getASTSummaryCache(opts?: ASTSummaryCacheOptions): ASTSummaryCache {
  if (!singleton) singleton = new ASTSummaryCache(opts);
  return singleton;
}

/** Test helper. */
export function __resetASTSummaryCacheSingleton(): void {
  singleton = null;
}

// ── Repository rebuild from a clone directory ───────────────────────────────

/** Directories never worth indexing. */
const REBUILD_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  ".cache",
]);

/** Skip individual files larger than this (likely generated/minified). */
const REBUILD_MAX_FILE_SIZE_BYTES = 256 * 1024;
/** Hard cap on the number of source files indexed per rebuild. */
const REBUILD_MAX_FILES = 5_000;

async function* walkSourceFiles(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (REBUILD_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (entry.isFile() && detectLanguage(entry.name)) {
      yield full;
    }
  }
}

export interface RebuildFromDirResult {
  indexed: number;
  skipped: number;
  totalSymbols: number;
  /** Files discovered before the {@link REBUILD_MAX_FILES} cap was applied. */
  discovered: number;
}

/**
 * Rebuild the AST summary cache for every supported source file under
 * `cloneDir`. Reads files from disk (skipping vendored/build directories and
 * oversized blobs) and re-indexes them through {@link ASTSummaryCache.rebuildForFiles}.
 *
 * Returns accurate rebuild statistics — this is the real implementation that
 * replaced the former no-op stub on the `rebuild-cache` route (#122).
 */
export async function rebuildCacheFromCloneDir(
  cache: ASTSummaryCache,
  cloneDir: string,
): Promise<RebuildFromDirResult> {
  const files: Array<{ path: string; content: string }> = [];
  let discovered = 0;

  for await (const filePath of walkSourceFiles(cloneDir)) {
    discovered++;
    if (files.length >= REBUILD_MAX_FILES) continue;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > REBUILD_MAX_FILE_SIZE_BYTES) continue;
      const content = await fs.readFile(filePath, "utf-8");
      const rel = path.relative(cloneDir, filePath).split(path.sep).join("/");
      files.push({ path: rel, content });
    } catch {
      // Unreadable file — skip.
    }
  }

  const stats = await cache.rebuildForFiles(files);
  log.info("rebuilt AST cache from clone dir", { cloneDir, discovered, ...stats });
  return { ...stats, discovered };
}
