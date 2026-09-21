/**
 * Epic #497 / Issue #499 — Token-budgeted repository map generator.
 *
 * Generates a formatted repository map within a token budget, with files
 * ranked by relevance to focus files or a query using graph distance scoring.
 * Handles repos up to 10K files without timeout (< 500ms target).
 */
import type { CodeGraphDataSource, GraphSymbol } from "./query-service.js";
import { CodeGraphQueryService } from "./query-service.js";

export interface RepoMapOptions {
  /** Maximum number of tokens in the output. */
  tokenBudget: number;
  /** Files to prioritize in the map. */
  focusFiles?: string[];
  /** Text query to use for relevance ranking. */
  query?: string;
}

export interface RepoMapEntry {
  filePath: string;
  symbols: string[];
  score: number;
}

export interface RepoMapResult {
  /** Formatted map text ready for LLM context. */
  content: string;
  /** Number of files included. */
  fileCount: number;
  /** Estimated token count of the output. */
  estimatedTokens: number;
  /** Files that were included. */
  entries: RepoMapEntry[];
}

/** Approximate tokens per character (conservative estimate). */
const CHARS_PER_TOKEN = 4;

/**
 * Simple token estimation: 1 token ≈ 4 characters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class RepoMapGenerator {
  private readonly queryService: CodeGraphQueryService;

  constructor(private readonly dataSource: CodeGraphDataSource) {
    this.queryService = new CodeGraphQueryService(dataSource);
  }

  /**
   * Generate a repo map within the token budget.
   * Files are ranked by relevance to focusFiles or query.
   */
  async generate(opts: RepoMapOptions): Promise<RepoMapResult> {
    const { tokenBudget, focusFiles, query } = opts;
    const entries: RepoMapEntry[] = [];

    if (focusFiles && focusFiles.length > 0) {
      // Rank files by graph distance from focus files
      const scoredFiles = await this.rankByFocusFiles(focusFiles);
      entries.push(...scoredFiles);
    }

    if (query) {
      // Rank files by query relevance (simple keyword matching on symbol names)
      const queryScored = await this.rankByQuery(query);
      // Merge with existing entries (take higher score)
      for (const qs of queryScored) {
        const existing = entries.find((e) => e.filePath === qs.filePath);
        if (existing) {
          existing.score = Math.max(existing.score, qs.score);
        } else {
          entries.push(qs);
        }
      }
    }

    // Sort by score descending
    entries.sort((a, b) => b.score - a.score);

    // Build the output within token budget
    const header = "# Repository Map\n\n";
    let output = header;
    let tokenCount = estimateTokens(header);
    const includedEntries: RepoMapEntry[] = [];

    for (const entry of entries) {
      const line = this.formatEntry(entry);
      const lineTokens = estimateTokens(line);

      if (tokenCount + lineTokens > tokenBudget) break;

      output += line;
      tokenCount += lineTokens;
      includedEntries.push(entry);
    }

    return {
      content: output,
      fileCount: includedEntries.length,
      estimatedTokens: tokenCount,
      entries: includedEntries,
    };
  }

  private async rankByFocusFiles(focusFiles: string[]): Promise<RepoMapEntry[]> {
    const fileScores = new Map<string, { score: number; symbols: string[] }>();

    // Add focus files themselves with highest score
    for (const fp of focusFiles) {
      const symbols = await this.dataSource.getSymbolsByFile(fp);
      fileScores.set(fp, {
        score: 10.0,
        symbols: symbols.map((s) => `${s.kind} ${s.qualifiedName}`),
      });
    }

    // Get related files for each focus file
    for (const fp of focusFiles) {
      const related = await this.queryService.getRelatedFiles(fp, 50);
      for (const rel of related) {
        const existing = fileScores.get(rel.filePath);
        const symbols = await this.dataSource.getSymbolsByFile(rel.filePath);
        const symbolNames = symbols.map((s) => `${s.kind} ${s.qualifiedName}`);

        if (existing) {
          existing.score = Math.max(existing.score, rel.score);
        } else {
          fileScores.set(rel.filePath, { score: rel.score, symbols: symbolNames });
        }
      }
    }

    return [...fileScores.entries()].map(([filePath, { score, symbols }]) => ({
      filePath,
      symbols,
      score,
    }));
  }

  private async rankByQuery(query: string): Promise<RepoMapEntry[]> {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) return [];

    const fileScores = new Map<string, { score: number; symbols: string[] }>();

    // Score files based on symbol name matching against query terms
    // This is a simple heuristic; a full implementation would use embeddings
    const allFiles = new Set<string>();

    // Get symbols from focus-file neighbors (limited scan for performance)
    // For a full implementation, this would query the database with LIKE patterns
    for (const term of queryTerms) {
      // Simple approach: check known symbols for term matches
      // In production this would be a DB query
      const matchingSymbols = await this.findSymbolsByNamePattern(term);
      for (const sym of matchingSymbols) {
        allFiles.add(sym.filePath);
        const existing = fileScores.get(sym.filePath);
        if (existing) {
          existing.score += 1.0;
          if (!existing.symbols.includes(`${sym.kind} ${sym.qualifiedName}`)) {
            existing.symbols.push(`${sym.kind} ${sym.qualifiedName}`);
          }
        } else {
          fileScores.set(sym.filePath, {
            score: 1.0,
            symbols: [`${sym.kind} ${sym.qualifiedName}`],
          });
        }
      }
    }

    return [...fileScores.entries()].map(([filePath, { score, symbols }]) => ({
      filePath,
      symbols,
      score,
    }));
  }

  /**
   * Find symbols whose qualified name contains the given pattern.
   * This is a simplified version — in production this would be a DB query.
   */
  protected async findSymbolsByNamePattern(_pattern: string): Promise<GraphSymbol[]> {
    // The data source doesn't have a search method, so this is a no-op in the
    // base implementation. Subclasses or extended data sources can override.
    // The query-based ranking is additive to focus-file ranking.
    return [];
  }

  private formatEntry(entry: RepoMapEntry): string {
    const symbolList =
      entry.symbols.length > 0 ? entry.symbols.slice(0, 10).join(", ") : "(no symbols)";
    return `${entry.filePath}: ${symbolList}\n`;
  }
}
