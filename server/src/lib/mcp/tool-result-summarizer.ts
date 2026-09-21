/**
 * Epic #502 / Issue #505 — Tool result summarization for long outputs.
 *
 * Summarizes tool results that exceed a token threshold to reduce context
 * window consumption. Uses heuristic extraction of key fields from JSON.
 *
 * - Threshold: only summarize results exceeding 2K tokens
 * - Preserves: IDs, URLs, error messages
 * - Prefixed with `[Summarized from N tokens]` marker
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("tool-result-summarizer");

/** Default threshold in tokens above which summarization kicks in. */
const DEFAULT_THRESHOLD_TOKENS = 2000;

/** Approximate tokens per character. */
const CHARS_PER_TOKEN = 4;

/** Fields that are always preserved in summarized output. */
const ALWAYS_PRESERVE_FIELDS = ["id", "url", "error", "message", "name", "title", "status"];

/** URL pattern for detection in non-JSON content. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

export interface SummarizerOptions {
  /** Token threshold for triggering summarization. Default: 2000. */
  thresholdTokens?: number;
  /** Per-tool extraction rules. Keys are tool names, values are field paths to preserve. */
  toolRules?: Record<string, string[]>;
  /** Maximum output tokens after summarization. Default: 500. */
  maxOutputTokens?: number;
}

export interface SummarizeResult {
  /** The summarized content. */
  content: string;
  /** Whether summarization was applied. */
  wasSummarized: boolean;
  /** Original token count. */
  originalTokens: number;
  /** Summarized token count (same as original if not summarized). */
  summarizedTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class ToolResultSummarizer {
  private readonly threshold: number;
  private readonly toolRules: Record<string, string[]>;
  private readonly maxOutput: number;

  constructor(opts: SummarizerOptions = {}) {
    this.threshold = opts.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
    this.toolRules = opts.toolRules ?? {};
    this.maxOutput = opts.maxOutputTokens ?? 500;
  }

  /**
   * Summarize a tool result if it exceeds the threshold.
   */
  summarize(toolName: string, content: string): SummarizeResult {
    const originalTokens = estimateTokens(content);

    if (originalTokens <= this.threshold) {
      return {
        content,
        wasSummarized: false,
        originalTokens,
        summarizedTokens: originalTokens,
      };
    }

    log.info("Summarizing tool result", { toolName, originalTokens, threshold: this.threshold });

    let summarized: string;

    // Try JSON extraction first
    const jsonResult = this.tryJsonSummarize(toolName, content);
    if (jsonResult) {
      summarized = jsonResult;
    } else {
      // Fall back to text truncation with key info preservation
      summarized = this.textSummarize(content);
    }

    // Ensure output is within budget
    const maxChars = this.maxOutput * CHARS_PER_TOKEN;
    if (summarized.length > maxChars) {
      summarized = summarized.slice(0, maxChars - 3) + "...";
    }

    const prefix = `[Summarized from ${originalTokens} tokens]\n`;
    const finalContent = prefix + summarized;
    const summarizedTokens = estimateTokens(finalContent);

    return {
      content: finalContent,
      wasSummarized: true,
      originalTokens,
      summarizedTokens,
    };
  }

  private tryJsonSummarize(toolName: string, content: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    if (parsed === null || typeof parsed !== "object") return null;

    const preserveFields = [...ALWAYS_PRESERVE_FIELDS, ...(this.toolRules[toolName] ?? [])];

    if (Array.isArray(parsed)) {
      return this.summarizeArray(parsed, preserveFields);
    }

    return this.summarizeObject(parsed as Record<string, unknown>, preserveFields);
  }

  private summarizeArray(arr: unknown[], preserveFields: string[]): string {
    const count = arr.length;
    // Extract key fields from first few items
    const sampleSize = Math.min(5, arr.length);
    const samples = arr.slice(0, sampleSize).map((item) => {
      if (typeof item === "object" && item !== null) {
        return this.extractPreservedFields(item as Record<string, unknown>, preserveFields);
      }
      return String(item).slice(0, 100);
    });

    const lines = [`Array with ${count} items (showing first ${sampleSize}):`];
    for (const sample of samples) {
      if (typeof sample === "string") {
        lines.push(`  - ${sample}`);
      } else {
        lines.push(`  - ${JSON.stringify(sample)}`);
      }
    }
    if (count > sampleSize) {
      lines.push(`  ... and ${count - sampleSize} more items`);
    }

    return lines.join("\n");
  }

  private summarizeObject(obj: Record<string, unknown>, preserveFields: string[]): string {
    const extracted = this.extractPreservedFields(obj, preserveFields);
    const keys = Object.keys(obj);
    const omittedKeys = keys.filter((k) => !(k in extracted));

    const lines: string[] = [];
    lines.push(JSON.stringify(extracted, null, 2));
    if (omittedKeys.length > 0) {
      lines.push(
        `[${omittedKeys.length} additional fields omitted: ${omittedKeys.slice(0, 10).join(", ")}${omittedKeys.length > 10 ? "..." : ""}]`,
      );
    }

    return lines.join("\n");
  }

  private extractPreservedFields(
    obj: Record<string, unknown>,
    preserveFields: string[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(obj)) {
      if (preserveFields.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        const value = obj[key];
        // Truncate long string values
        if (typeof value === "string" && value.length > 200) {
          result[key] = value.slice(0, 200) + "...";
        } else {
          result[key] = value;
        }
      }
    }

    return result;
  }

  private textSummarize(content: string): string {
    const lines: string[] = [];

    // Extract URLs
    const urls = content.match(URL_PATTERN);
    if (urls && urls.length > 0) {
      lines.push(
        `URLs found: ${urls.slice(0, 5).join(", ")}${urls.length > 5 ? ` (+${urls.length - 5} more)` : ""}`,
      );
    }

    // Extract error-like patterns
    const errorPattern = /(?:error|Error|ERROR)[:\s].*$/gm;
    const errors = content.match(errorPattern);
    if (errors && errors.length > 0) {
      lines.push("Errors:");
      for (const err of errors.slice(0, 3)) {
        lines.push(`  ${err.trim().slice(0, 200)}`);
      }
    }

    // Include first and last portions of content
    const maxPreview = 500;
    if (content.length > maxPreview * 2) {
      lines.push("Content preview:");
      lines.push(content.slice(0, maxPreview));
      lines.push("...");
      lines.push(content.slice(-maxPreview));
    } else {
      lines.push(content.slice(0, maxPreview * 2));
    }

    return lines.join("\n");
  }
}
