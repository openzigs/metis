/**
 * Task Profile Classifier (Epic #593 / Issue #598).
 *
 * Classifies AI tasks by reasoning depth, token estimate, and latency SLA
 * so the ModelRouter can select the optimal model (Haiku vs Sonnet).
 */
import type { LatencySLA, ReasoningDepth, TaskProfile, TaskType } from "./types.js";

/** Approximate tokens per character (GPT-family heuristic). */
const CHARS_PER_TOKEN = 4;

/** Expected output multiplier by task type. */
const OUTPUT_MULTIPLIERS: Record<TaskType, number> = {
  summarization: 0.3,
  extraction: 0.4,
  analysis: 0.8,
  synthesis: 1.2,
  "cross-referencing": 1.0,
  general: 0.6,
};

/** Keywords that signal simple reasoning tasks. */
const SIMPLE_KEYWORDS = [
  "summarize",
  "summarise",
  "summary",
  "extract",
  "list",
  "identify",
  "find",
  "retrieve",
  "lookup",
  "describe",
];

/** Keywords that signal complex reasoning tasks. */
const COMPLEX_KEYWORDS = [
  "synthesize",
  "synthesise",
  "cross-reference",
  "compare and contrast",
  "evaluate",
  "recommend",
  "design",
  "architect",
  "trade-off",
  "tradeoff",
  "implications",
  "impact analysis",
];

/**
 * Classifies tasks based on content and context to produce a {@link TaskProfile}.
 */
export class TaskProfiler {
  /**
   * Classify a task based on the input content and optional agent key.
   *
   * @param content   The input text content (prompt + context)
   * @param agentKey  Optional specialist agent key for heuristic hints
   */
  classify(content: string, agentKey?: string): TaskProfile {
    const taskType = this.classifyTaskType(content, agentKey);
    const reasoningDepth = this.classifyReasoningDepth(content, taskType, agentKey);
    const tokenEstimate = this.estimateTokens(content, taskType);
    const latencySLA = this.classifyLatencySLA(reasoningDepth, tokenEstimate);

    return { tokenEstimate, reasoningDepth, latencySLA, taskType };
  }

  /** Classify the high-level task type from content and agent hints. */
  classifyTaskType(content: string, agentKey?: string): TaskType {
    const lower = content.toLowerCase();

    // Agent-based heuristics
    if (agentKey === "document") return "extraction";
    if (agentKey === "web") return "cross-referencing";
    if (agentKey === "database") return "analysis";
    if (agentKey === "code") return "analysis";
    if (agentKey === "synthesis") return "synthesis";

    // Keyword-based classification
    if (COMPLEX_KEYWORDS.some((kw) => lower.includes(kw))) return "synthesis";
    if (SIMPLE_KEYWORDS.some((kw) => lower.includes(kw))) return "summarization";

    // Length-based heuristic: very short prompts are usually simple
    if (content.length < 200) return "general";

    return "analysis";
  }

  /** Classify reasoning depth from content characteristics and task type. */
  classifyReasoningDepth(content: string, taskType: TaskType, agentKey?: string): ReasoningDepth {
    // Synthesis and cross-referencing are always complex
    if (taskType === "synthesis" || taskType === "cross-referencing") return "complex";

    // Summarization and extraction are simple
    if (taskType === "summarization" || taskType === "extraction") return "simple";

    // Agent-specific heuristics for analysis type
    if (agentKey === "code") return "moderate";
    if (agentKey === "database") return "moderate";

    // Content length heuristic: longer content suggests more complex reasoning
    if (content.length > 10_000) return "complex";
    if (content.length > 2_000) return "moderate";

    return "simple";
  }

  /** Estimate total token consumption (input + expected output). */
  estimateTokens(content: string, taskType: TaskType): number {
    const inputTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
    const outputMultiplier = OUTPUT_MULTIPLIERS[taskType];
    const outputTokens = Math.ceil(inputTokens * outputMultiplier);
    return inputTokens + outputTokens;
  }

  /**
   * Classify latency SLA from reasoning depth and token estimate.
   *
   * `tokenEstimate` is `null` when no honest estimate exists (#1095); depth then
   * decides alone, and we never claim "interactive" on an unknown workload.
   */
  classifyLatencySLA(reasoningDepth: ReasoningDepth, tokenEstimate: number | null): LatencySLA {
    if (tokenEstimate == null) return reasoningDepth === "complex" ? "background" : "standard";
    if (reasoningDepth === "simple" && tokenEstimate < 2_000) return "interactive";
    if (reasoningDepth === "complex" || tokenEstimate > 20_000) return "background";
    return "standard";
  }
}
