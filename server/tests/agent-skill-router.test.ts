/**
 * Epic #596 / Issue #621 — Agent Skill Router unit tests.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { AgentSkillRouter } from "../src/lib/analysis/agent-skill-router.js";

describe("AgentSkillRouter", () => {
  describe("route — default config", () => {
    let router: AgentSkillRouter;

    beforeEach(() => {
      router = new AgentSkillRouter();
    });

    it("routes code-heavy input to code agent", () => {
      const decision = router.route(
        "Analyze the function implementation and class architecture. Check API endpoints.",
      );
      expect(decision.selectedAgents).toContain("code");
      expect(decision.scores.code).toBeGreaterThan(0);
    });

    it("routes document-heavy input to document agent", () => {
      const decision = router.route(
        "Review the business requirements, stakeholder goals, and compliance rules.",
      );
      expect(decision.selectedAgents).toContain("document");
    });

    it("routes database input to database agent", () => {
      const decision = router.route(
        "Analyze the database schema, table relationships, and migration plan.",
      );
      expect(decision.selectedAgents).toContain("database");
    });

    it("routes web/research input to web agent", () => {
      const decision = router.route(
        "Research industry standards and best practices for compliance audit.",
      );
      expect(decision.selectedAgents).toContain("web");
    });

    it("selects multiple agents for mixed input", () => {
      const decision = router.route(
        "Analyze the code architecture, review requirements, and check database schema.",
      );
      expect(decision.selectedAgents.length).toBeGreaterThanOrEqual(2);
    });

    it("always selects at least one agent", () => {
      const decision = router.route("xyzzy gibberish nothing relevant");
      expect(decision.selectedAgents.length).toBeGreaterThanOrEqual(1);
    });

    it("respects available agents filter", () => {
      const decision = router.route("Review code and database", ["code", "database"]);
      expect(decision.selectedAgents.every((a) => ["code", "database"].includes(a))).toBe(true);
    });
  });

  describe("forceAllAgents mode", () => {
    it("selects all available agents", () => {
      const router = new AgentSkillRouter({ forceAllAgents: true });
      const decision = router.route("simple query");
      expect(decision.selectedAgents).toEqual(["document", "code", "database", "web"]);
      expect(decision.forcedAllAgents).toBe(true);
      expect(decision.reason).toContain("forced");
    });
  });

  describe("budget constraint", () => {
    it("restricts to top-1 agent when budget is low", () => {
      const router = new AgentSkillRouter({
        tokenBudget: 10_000,
        lowBudgetThreshold: 25_000,
      });
      const decision = router.route(
        "Analyze code architecture, review requirements, check database schema.",
      );
      expect(decision.selectedAgents).toHaveLength(1);
      expect(decision.budgetConstrained).toBe(true);
    });

    it("allows multiple agents when budget is sufficient", () => {
      const router = new AgentSkillRouter({
        tokenBudget: 100_000,
        lowBudgetThreshold: 25_000,
      });
      const decision = router.route(
        "Analyze code architecture, review requirements, check database schema.",
      );
      expect(decision.selectedAgents.length).toBeGreaterThanOrEqual(1);
      expect(decision.budgetConstrained).toBe(false);
    });
  });

  describe("minRelevanceScore", () => {
    it("filters agents below minimum score", () => {
      const router = new AgentSkillRouter({ minRelevanceScore: 0.5 });
      const decision = router.route("analyze class function method interface");
      // code should score high, others low
      expect(decision.selectedAgents).toContain("code");
      // Web agent unlikely to score above 0.5 with this input
      expect(decision.scores.web).toBeLessThan(0.5);
    });
  });

  describe("decision log", () => {
    it("records routing decisions", () => {
      const router = new AgentSkillRouter();
      router.route("first query");
      router.route("second query");
      expect(router.getDecisionLog()).toHaveLength(2);
    });

    it("can clear the log", () => {
      const router = new AgentSkillRouter();
      router.route("query");
      router.clearLog();
      expect(router.getDecisionLog()).toHaveLength(0);
    });
  });

  describe("scores", () => {
    it("returns scores for all agents", () => {
      const router = new AgentSkillRouter();
      const decision = router.route("test query");
      expect(Object.keys(decision.scores)).toEqual(
        expect.arrayContaining(["document", "code", "database", "web"]),
      );
    });

    it("scores are between 0 and 1", () => {
      const router = new AgentSkillRouter();
      const decision = router.route(
        "analyze code function class interface module import export api endpoint controller service",
      );
      for (const score of Object.values(decision.scores)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });
});
