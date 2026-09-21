/**
 * Epic #511 / Issue #514 — Adaptive token budget allocation by query type.
 *
 * Classifies queries into types and allocates per-category token budgets
 * based on configurable profiles. Learns from session telemetry to reallocate
 * underused budget fractions toward categories that need more headroom.
 *
 * Extends (does not replace) the existing `TokenBudget` class.
 */
import { TokenCategory } from "../ai/token-categorizer.js";
import { TokenBudget, type TokenBudgetOptions } from "./token-budget.js";

/**
 * Supported query types that drive budget allocation profiles.
 */
export enum QueryType {
  CODE_QUERY = "code_query",
  DOCUMENT_QUERY = "document_query",
  TOOL_WORKFLOW = "tool_workflow",
  GENERAL_CHAT = "general_chat",
}

/**
 * A category allocation profile — values are percentages (0-1) that sum to 1.
 */
export interface AllocationProfile {
  [TokenCategory.CODE_CONTEXT]: number;
  [TokenCategory.TOOL_MANIFESTS]: number;
  [TokenCategory.TOOL_RESULTS]: number;
  [TokenCategory.HISTORY]: number;
  [TokenCategory.RAG_CONTEXT]: number;
  [TokenCategory.SYSTEM_PROMPT]: number;
  [TokenCategory.USER_MESSAGE]: number;
}

/**
 * Default allocation profiles per query type.
 */
export const DEFAULT_PROFILES: Record<QueryType, AllocationProfile> = {
  [QueryType.CODE_QUERY]: {
    [TokenCategory.CODE_CONTEXT]: 0.4,
    [TokenCategory.TOOL_MANIFESTS]: 0.1,
    [TokenCategory.TOOL_RESULTS]: 0.1,
    [TokenCategory.HISTORY]: 0.2,
    [TokenCategory.RAG_CONTEXT]: 0.1,
    [TokenCategory.SYSTEM_PROMPT]: 0.05,
    [TokenCategory.USER_MESSAGE]: 0.05,
  },
  [QueryType.TOOL_WORKFLOW]: {
    [TokenCategory.CODE_CONTEXT]: 0.15,
    [TokenCategory.TOOL_MANIFESTS]: 0.2,
    [TokenCategory.TOOL_RESULTS]: 0.2,
    [TokenCategory.HISTORY]: 0.25,
    [TokenCategory.RAG_CONTEXT]: 0.1,
    [TokenCategory.SYSTEM_PROMPT]: 0.05,
    [TokenCategory.USER_MESSAGE]: 0.05,
  },
  [QueryType.DOCUMENT_QUERY]: {
    [TokenCategory.CODE_CONTEXT]: 0.1,
    [TokenCategory.TOOL_MANIFESTS]: 0.05,
    [TokenCategory.TOOL_RESULTS]: 0.1,
    [TokenCategory.HISTORY]: 0.25,
    [TokenCategory.RAG_CONTEXT]: 0.4,
    [TokenCategory.SYSTEM_PROMPT]: 0.05,
    [TokenCategory.USER_MESSAGE]: 0.05,
  },
  [QueryType.GENERAL_CHAT]: {
    [TokenCategory.CODE_CONTEXT]: 0.15,
    [TokenCategory.TOOL_MANIFESTS]: 0.1,
    [TokenCategory.TOOL_RESULTS]: 0.1,
    [TokenCategory.HISTORY]: 0.3,
    [TokenCategory.RAG_CONTEXT]: 0.15,
    [TokenCategory.SYSTEM_PROMPT]: 0.1,
    [TokenCategory.USER_MESSAGE]: 0.1,
  },
};

/** Minimum data points required before adaptive reallocation kicks in. */
const MIN_DATA_POINTS = 10;

/** Maximum reallocation shift per category (prevent extreme swings). */
const MAX_SHIFT = 0.15;

export interface TelemetryDataPoint {
  queryType: QueryType;
  categoryBreakdown: Record<string, number>;
  totalTokens: number;
}

export interface CategoryBudget {
  category: TokenCategory;
  /** Allocated token count for this category. */
  tokens: number;
  /** Allocation percentage (0-1). */
  percentage: number;
}

export interface AdaptiveBudgetOptions extends TokenBudgetOptions {
  /** Custom profiles override defaults. */
  profiles?: Partial<Record<QueryType, AllocationProfile>>;
}

/**
 * Classifies a user query into a QueryType using keyword heuristics.
 */
export function classifyQuery(query: string): QueryType {
  const lower = query.toLowerCase();

  // Code-related signals
  const codeSignals = [
    "function",
    "class",
    "method",
    "variable",
    "import",
    "export",
    "refactor",
    "bug",
    "error",
    "fix",
    "implement",
    "code",
    "typescript",
    "javascript",
    "python",
    "compile",
    "syntax",
    "debug",
  ];

  // Tool/workflow signals
  const toolSignals = [
    "run",
    "execute",
    "deploy",
    "build",
    "install",
    "create file",
    "delete",
    "terminal",
    "command",
    "script",
    "pipeline",
    "workflow",
    "automate",
  ];

  // Document/knowledge signals
  const docSignals = [
    "document",
    "requirement",
    "specification",
    "explain",
    "describe",
    "summarize",
    "what is",
    "how does",
    "architecture",
    "design",
    "overview",
    "guide",
  ];

  let codeScore = 0;
  let toolScore = 0;
  let docScore = 0;

  for (const signal of codeSignals) {
    if (lower.includes(signal)) codeScore++;
  }
  for (const signal of toolSignals) {
    if (lower.includes(signal)) toolScore++;
  }
  for (const signal of docSignals) {
    if (lower.includes(signal)) docScore++;
  }

  const maxScore = Math.max(codeScore, toolScore, docScore);
  if (maxScore === 0) return QueryType.GENERAL_CHAT;
  if (codeScore === maxScore) return QueryType.CODE_QUERY;
  if (toolScore === maxScore) return QueryType.TOOL_WORKFLOW;
  return QueryType.DOCUMENT_QUERY;
}

/**
 * AdaptiveBudgetAllocator extends TokenBudget with per-category allocation
 * that adapts based on telemetry data from prior sessions.
 */
export class AdaptiveBudgetAllocator extends TokenBudget {
  private readonly profiles: Record<QueryType, AllocationProfile>;
  private telemetryHistory: TelemetryDataPoint[] = [];

  constructor(opts: AdaptiveBudgetOptions) {
    super(opts);
    this.profiles = {
      ...DEFAULT_PROFILES,
      ...opts.profiles,
    };
  }

  /**
   * Feed telemetry data from previous sessions. The allocator uses this
   * to learn which categories consistently underuse their budget.
   */
  addTelemetry(dataPoints: TelemetryDataPoint[]): void {
    this.telemetryHistory.push(...dataPoints);
  }

  /** Number of telemetry data points available. */
  get dataPointCount(): number {
    return this.telemetryHistory.length;
  }

  /**
   * Compute per-category token budgets for the given query.
   *
   * If sufficient telemetry exists (≥10 data points for the query type),
   * adaptive reallocation shifts budget from underused to overused categories.
   * Otherwise, uses the static profile.
   */
  allocate(query: string): CategoryBudget[] {
    const queryType = classifyQuery(query);
    return this.allocateForType(queryType);
  }

  /**
   * Allocate for a known query type directly.
   */
  allocateForType(queryType: QueryType): CategoryBudget[] {
    const baseProfile = this.profiles[queryType];
    const totalBudget = this.total;

    const relevantData = this.telemetryHistory.filter((d) => d.queryType === queryType);
    const profile =
      relevantData.length >= MIN_DATA_POINTS
        ? this.adaptProfile(baseProfile, relevantData)
        : baseProfile;

    return Object.values(TokenCategory).map((category) => ({
      category,
      tokens: Math.round(profile[category] * totalBudget),
      percentage: profile[category],
    }));
  }

  /**
   * Adapt allocation profile based on historical telemetry.
   *
   * Categories that consistently use less than their allocation get their
   * surplus redistributed to categories that use more than their allocation.
   */
  private adaptProfile(base: AllocationProfile, history: TelemetryDataPoint[]): AllocationProfile {
    // Compute average actual usage fractions across history
    const avgUsage: Record<string, number> = {};
    const categories = Object.values(TokenCategory);

    for (const cat of categories) {
      let sum = 0;
      let count = 0;
      for (const dp of history) {
        if (dp.totalTokens > 0 && dp.categoryBreakdown[cat] !== undefined) {
          sum += dp.categoryBreakdown[cat] / dp.totalTokens;
          count++;
        }
      }
      avgUsage[cat] = count > 0 ? sum / count : base[cat];
    }

    // Compute deltas (positive = category needs more, negative = overallocated)
    const deltas: Record<string, number> = {};
    for (const cat of categories) {
      deltas[cat] = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, avgUsage[cat] - base[cat]));
    }

    // Build adapted profile, ensuring no category drops below 0.01 (1%)
    const adapted: Record<string, number> = {};
    for (const cat of categories) {
      adapted[cat] = Math.max(0.01, base[cat] + deltas[cat] * 0.5); // dampen shifts by 50%
    }

    // Normalize to sum to 1.0
    const total = Object.values(adapted).reduce((s, v) => s + v, 0);
    for (const cat of categories) {
      adapted[cat] = adapted[cat] / total;
    }

    return adapted as unknown as AllocationProfile;
  }
}
