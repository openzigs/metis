/**
 * Epic #596 / Issue #617 — Code Graph-First Strategy.
 *
 * Intercepts agent tool calls and routes them to the AST summary cache
 * first. Only falls through to full file reads when the summary is
 * insufficient. Logs the fallthrough rate and alerts when it exceeds
 * a configurable threshold (default 30%).
 */
import { createChildLogger } from "../../logger.js";
import { type ASTSummaryCache, type CachedSummary } from "../ast-summary-cache.js";
import type { AgentTool, ToolContext, ToolResult } from "../tools/types.js";

const log = createChildLogger("code-graph-first");

export interface CodeGraphFirstOptions {
  /** AST summary cache instance. */
  cache: ASTSummaryCache;
  /** Fallthrough rate alert threshold (0-1). Default: 0.30. */
  alertThreshold?: number;
  /** If true, always fall through to full file reads (bypass). Default: false. */
  bypass?: boolean;
}

export interface StrategyStats {
  intercepted: number;
  cacheHits: number;
  fallthroughs: number;
  fallthroughRate: number;
  alertTriggered: boolean;
}

/**
 * Code Graph-First Strategy — wraps existing agent tools to try
 * the AST summary cache before reading full files.
 */
export class CodeGraphFirstStrategy {
  private readonly cache: ASTSummaryCache;
  private readonly alertThreshold: number;
  private readonly bypass: boolean;
  private intercepted = 0;
  private cacheHits = 0;
  private fallthroughs = 0;
  private alertTriggered = false;

  constructor(opts: CodeGraphFirstOptions) {
    this.cache = opts.cache;
    this.alertThreshold = opts.alertThreshold ?? 0.3;
    this.bypass = opts.bypass ?? false;
  }

  /**
   * Wrap an array of agent tools so that file-read tools check the
   * summary cache first.
   */
  wrapTools(tools: AgentTool[]): AgentTool[] {
    if (this.bypass) return tools;
    return tools.map((tool) => this.wrapTool(tool));
  }

  /**
   * Wrap a single tool. Only intercepts tools whose name includes
   * "read_file" or "file_slice".
   */
  wrapTool(tool: AgentTool): AgentTool {
    const isFileReadTool = /read_file|file_slice/i.test(tool.name);
    if (!isFileReadTool) return tool;

    const interceptFn = this.createInterceptor(tool);
    return { ...tool, execute: interceptFn };
  }

  private createInterceptor(
    tool: AgentTool,
  ): (args: unknown, context: ToolContext) => Promise<ToolResult> {
    return async (args: unknown, context: ToolContext): Promise<ToolResult> => {
      const { filePath, path } = args as { filePath?: string; path?: string };
      const resolvedPath = filePath ?? path;

      if (!resolvedPath) {
        return tool.execute(args, context);
      }

      this.intercepted++;

      const lookup = await this.cache.lookup(resolvedPath);
      if (lookup.hit && lookup.summaries.length > 0) {
        this.cacheHits++;
        const summaryText = formatSummaries(resolvedPath, lookup.summaries);
        log.debug("cache hit", { filePath: resolvedPath, symbols: lookup.summaries.length });
        return { content: summaryText };
      }

      // Fall through to original tool
      this.fallthroughs++;
      this.checkAlertThreshold();
      log.debug("cache miss — falling through to full read", { filePath: resolvedPath });
      return tool.execute(args, context);
    };
  }

  /**
   * Get current strategy statistics.
   */
  get stats(): StrategyStats {
    const rate = this.intercepted === 0 ? 0 : this.fallthroughs / this.intercepted;
    return {
      intercepted: this.intercepted,
      cacheHits: this.cacheHits,
      fallthroughs: this.fallthroughs,
      fallthroughRate: rate,
      alertTriggered: this.alertTriggered,
    };
  }

  /**
   * Reset statistics counters.
   */
  resetStats(): void {
    this.intercepted = 0;
    this.cacheHits = 0;
    this.fallthroughs = 0;
    this.alertTriggered = false;
  }

  private checkAlertThreshold(): void {
    if (this.intercepted < 10) return; // Minimum sample size
    const rate = this.fallthroughs / this.intercepted;
    if (rate > this.alertThreshold && !this.alertTriggered) {
      this.alertTriggered = true;
      log.warn("fallthrough rate exceeds threshold — AST cache may need rebuild", {
        rate: (rate * 100).toFixed(1) + "%",
        threshold: (this.alertThreshold * 100).toFixed(1) + "%",
      });
    }
  }
}

function formatSummaries(filePath: string, summaries: CachedSummary[]): string {
  const header = `## File: ${filePath} (AST Summary, ${summaries.length} symbols)\n\n`;
  const body = summaries
    .map(
      (s) =>
        `### ${s.kind} ${s.symbol}\nSignature: ${s.signature}\n${s.summary}\nLines: ${s.startLine}-${s.endLine}`,
    )
    .join("\n\n");
  return header + body;
}
