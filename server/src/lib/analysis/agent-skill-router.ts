/**
 * Epic #596 / Issue #619 — Agent Skill Router.
 *
 * Analyzes input to classify which specialist agent domains are relevant
 * (document, code, database, web). Only invokes relevant agents, reducing
 * unnecessary token spend. Considers token budget: low budget = top-1 agent.
 *
 * Configuration supports forcing all-agent mode. Logs all routing decisions.
 */
import type { AnalysisSpecialistAgentKey } from "@metis/shared";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("agent-skill-router");

export interface RoutingDecision {
  /** Agents selected for this analysis. */
  selectedAgents: AnalysisSpecialistAgentKey[];
  /** Relevance scores per agent (0-1). */
  scores: Record<string, number>;
  /** Reason for the routing decision. */
  reason: string;
  /** Whether the budget constraint affected selection. */
  budgetConstrained: boolean;
  /** Whether all-agent mode was forced. */
  forcedAllAgents: boolean;
}

export interface AgentSkillRouterOptions {
  /** Force all agents regardless of relevance. Default: false. */
  forceAllAgents?: boolean;
  /** Minimum relevance score to include an agent (0-1). Default: 0.2. */
  minRelevanceScore?: number;
  /** Token budget for the analysis. If below lowBudgetThreshold, only top-1 agent. */
  tokenBudget?: number;
  /** Threshold below which only the top agent is selected. Default: 25_000. */
  lowBudgetThreshold?: number;
}

/** Domain-specific keyword sets for routing heuristics. */
const DOMAIN_KEYWORDS: Record<AnalysisSpecialistAgentKey, string[]> = {
  document: [
    "requirement",
    "business",
    "stakeholder",
    "goal",
    "user story",
    "acceptance",
    "specification",
    "policy",
    "compliance",
    "regulatory",
    "process",
    "workflow",
    "document",
    "contract",
    "rules",
    "constraints",
    "success criteria",
    "scope",
  ],
  code: [
    "function",
    "class",
    "method",
    "interface",
    "module",
    "import",
    "export",
    "api",
    "endpoint",
    "controller",
    "service",
    "repository",
    "test",
    "lint",
    "refactor",
    "bug",
    "error",
    "exception",
    "type",
    "implementation",
    "code",
    "component",
    "architecture",
    "pattern",
    "framework",
  ],
  database: [
    "table",
    "column",
    "index",
    "migration",
    "schema",
    "query",
    "sql",
    "relationship",
    "entity",
    "model",
    "constraint",
    "foreign key",
    "primary key",
    "data model",
    "database",
    "join",
    "orm",
    "prisma",
    "sequelize",
  ],
  web: [
    "industry",
    "standard",
    "regulation",
    "benchmark",
    "best practice",
    "competitor",
    "market",
    "trend",
    "risk",
    "compliance",
    "audit",
    "comparable",
    "research",
    "external",
    "public",
  ],
};

/**
 * Agent Skill Router — classifies input and selects relevant agents.
 */
export class AgentSkillRouter {
  private readonly forceAllAgents: boolean;
  private readonly minScore: number;
  private readonly tokenBudget: number;
  private readonly lowBudgetThreshold: number;
  private readonly decisions: RoutingDecision[] = [];

  constructor(opts: AgentSkillRouterOptions = {}) {
    this.forceAllAgents = opts.forceAllAgents ?? false;
    this.minScore = opts.minRelevanceScore ?? 0.2;
    this.tokenBudget = opts.tokenBudget ?? Infinity;
    this.lowBudgetThreshold = opts.lowBudgetThreshold ?? 25_000;
  }

  /**
   * Analyze input and determine which agents should run.
   */
  route(
    input: string,
    availableAgents: AnalysisSpecialistAgentKey[] = ["document", "code", "database", "web"],
  ): RoutingDecision {
    // Force all agents if configured
    if (this.forceAllAgents) {
      const scores: Record<string, number> = {};
      for (const agent of availableAgents) scores[agent] = 1;
      const decision: RoutingDecision = {
        selectedAgents: [...availableAgents],
        scores,
        reason: "all-agent mode forced by configuration",
        budgetConstrained: false,
        forcedAllAgents: true,
      };
      this.logDecision(decision);
      return decision;
    }

    // Score each agent based on keyword matching
    const scores = this.scoreAgents(input, availableAgents);

    // Filter by minimum score
    let candidates = availableAgents
      .filter((agent) => scores[agent] >= this.minScore)
      .sort((a, b) => scores[b] - scores[a]);

    // If no candidates meet the threshold, use the top-scoring agent
    if (candidates.length === 0) {
      const topAgent = availableAgents.reduce((best, agent) =>
        scores[agent] > scores[best] ? agent : best,
      );
      candidates = [topAgent];
    }

    // Budget constraint: low budget → top-1 only
    const budgetConstrained = this.tokenBudget < this.lowBudgetThreshold;
    if (budgetConstrained && candidates.length > 1) {
      candidates = [candidates[0]];
    }

    const decision: RoutingDecision = {
      selectedAgents: candidates,
      scores,
      reason: budgetConstrained
        ? `low token budget (${this.tokenBudget}) — restricted to top agent`
        : `selected ${candidates.length} agents above relevance threshold (${this.minScore})`,
      budgetConstrained,
      forcedAllAgents: false,
    };

    this.logDecision(decision);
    return decision;
  }

  /**
   * Get the history of routing decisions.
   */
  getDecisionLog(): ReadonlyArray<Readonly<RoutingDecision>> {
    return this.decisions;
  }

  /**
   * Clear the decision log.
   */
  clearLog(): void {
    this.decisions.length = 0;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private scoreAgents(input: string, agents: AnalysisSpecialistAgentKey[]): Record<string, number> {
    const lowerInput = input.toLowerCase();
    const scores: Record<string, number> = {};

    for (const agent of agents) {
      const keywords = DOMAIN_KEYWORDS[agent] ?? [];
      let matchCount = 0;
      for (const kw of keywords) {
        if (lowerInput.includes(kw)) matchCount++;
      }
      // Normalize score to 0-1 range (cap at 1.0 when many keywords match)
      scores[agent] = Math.min(1, matchCount / Math.max(1, keywords.length * 0.3));
    }

    return scores;
  }

  private logDecision(decision: RoutingDecision): void {
    this.decisions.push(decision);
    log.info("routing decision", {
      selected: decision.selectedAgents,
      scores: Object.fromEntries(
        Object.entries(decision.scores).map(([k, v]) => [k, Number(v.toFixed(3))]),
      ),
      reason: decision.reason,
      budgetConstrained: decision.budgetConstrained,
    });
  }
}
