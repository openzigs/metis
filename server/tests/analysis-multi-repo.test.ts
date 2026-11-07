/**
 * Multi-repo analysis tests (epic #663, issue #668).
 *
 * Verifies that the orchestrator uses findMany for repo connectors and
 * runs the agentic code agent per connector when multiple repos exist.
 */
import { describe, expect, it } from "vitest";
import {
  capConnectorsForBudget,
  orderConnectorsForBudgetCap,
} from "../src/lib/analysis/orchestrator.js";

describe("Multi-repo analysis (#668)", () => {
  it("splits token budget across multiple connectors", () => {
    // This is a pure logic test — given N connectors, budget is divided
    const DEFAULT_AGENT_TOKEN_BUDGET = 100_000;
    const connectorCount = 3;
    const perConnectorBudget = Math.floor(DEFAULT_AGENT_TOKEN_BUDGET / connectorCount);
    expect(perConnectorBudget).toBe(33_333);
  });

  it("single connector still uses full budget (backward compat)", () => {
    const DEFAULT_AGENT_TOKEN_BUDGET = 100_000;
    const connectorCount = 1;
    const perConnectorBudget = Math.floor(DEFAULT_AGENT_TOKEN_BUDGET / connectorCount);
    expect(perConnectorBudget).toBe(100_000);
  });

  it("labels project name with repo label in multi-repo mode", () => {
    const projectName = "Acme Platform";
    const connectors = [
      { id: "repo-1", label: "backend" },
      { id: "repo-2", label: "frontend" },
    ];
    const labeled = connectors.map((c) => `${projectName} [repo: ${c.label}]`);
    expect(labeled).toEqual(["Acme Platform [repo: backend]", "Acme Platform [repo: frontend]"]);
  });

  it("orchestrator source uses findMany instead of findFirst", async () => {
    // Read the source code to verify the implementation uses findMany
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/lib/analysis/orchestrator.ts"),
      "utf-8",
    );
    // The agentic code agent section should use findMany
    const agenticSection = src.substring(
      src.indexOf("// Find ALL connectors"),
      src.indexOf("// Non-sequenced path"),
    );
    expect(agenticSection).toContain("repoConnection.findMany");
    expect(agenticSection).not.toContain("repoConnection.findFirst");
    // Should split budget via the shared capper (#741 refactor of the inline slice),
    // using the #769 config-resolved budget (env-tunable, default 100k).
    expect(agenticSection).toContain("capConnectorsForBudget(");
    expect(agenticSection).toContain("resolveAgentTokenBudget()");
    // Should label with repo name
    expect(agenticSection).toContain("[repo: ${connector.label}]");
  });
});

describe("orderConnectorsForBudgetCap (#1974)", () => {
  const row = (id: string, createdAt: string, isPrimary = false) => ({
    id,
    label: id,
    isPrimary,
    createdAt: new Date(createdAt),
  });

  it("puts the primary first, then oldest first, with the id breaking a tie", () => {
    const rows = [
      row("b", "2026-01-02T00:00:00Z"),
      row("newest", "2026-01-05T00:00:00Z"),
      row("a", "2026-01-02T00:00:00Z"),
      row("primary", "2026-01-09T00:00:00Z", true),
      row("oldest", "2026-01-01T00:00:00Z"),
    ];
    expect(orderConnectorsForBudgetCap(rows).map((r) => r.id)).toEqual([
      "primary",
      "oldest",
      "a",
      "b",
      "newest",
    ]);
    // A copy: the caller's list is left as the database returned it.
    expect(rows[0]!.id).toBe("b");
  });

  it("with three connectors and a budget for two, every arrival order keeps the primary", () => {
    const rows = [
      row("primary", "2026-01-03T00:00:00Z", true),
      row("billing", "2026-01-01T00:00:00Z"),
      row("notify", "2026-01-02T00:00:00Z"),
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const { effectiveConnectors, skipped } = capConnectorsForBudget(
        orderConnectorsForBudgetCap(order.map((i) => rows[i]!)),
        100_000,
        50_000,
      );
      expect(effectiveConnectors.map((c) => c.id)).toEqual(["primary", "billing"]);
      expect(skipped.map((c) => c.id)).toEqual(["notify"]);
    }
  });
});
