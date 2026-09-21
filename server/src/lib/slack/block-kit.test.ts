/**
 * Issue #579 — Block Kit builder tests. These produce the Slack message JSON for
 * status/approve/help/error; they are pure, so we assert the structural shape +
 * that the Approve button carries the action id + draft id.
 */
import { describe, expect, it } from "vitest";

import {
  APPROVE_ACTION_ID,
  buildApprovePromptBlocks,
  buildApprovedBlocks,
  buildBudgetAlertBlocks,
  buildErrorBlocks,
  buildHelpBlocks,
  buildStatusBlocks,
} from "./block-kit.js";
import type { ProjectHealthSummary } from "../teams/project-health.js";

function health(over: Partial<ProjectHealthSummary> = {}): ProjectHealthSummary {
  return {
    projectId: "p-1",
    name: "Acme",
    status: "active",
    requirementCount: 3,
    drafts: { pending: 1, approved: 0, published: 2 },
    latestAnalysisStatus: "completed",
    latestPublishStatus: "succeeded",
    ...over,
  };
}

describe("block-kit (#579)", () => {
  it("status blocks render the project name + fields", () => {
    const blocks = buildStatusBlocks(health());
    const json = JSON.stringify(blocks);
    expect(json).toContain("Acme");
    expect(json).toContain("completed");
    expect(json).toContain("succeeded");
  });

  it("status blocks fall back to 'none yet' when no analysis/publish has run", () => {
    const blocks = buildStatusBlocks(
      health({ latestAnalysisStatus: null, latestPublishStatus: null }),
    );
    expect(JSON.stringify(blocks)).toContain("none yet");
  });

  it("approve-prompt carries the Approve button with the action id + draft value", () => {
    const blocks = buildApprovePromptBlocks({ id: "d-1", title: "Add login" });
    const json = JSON.stringify(blocks);
    expect(json).toContain(APPROVE_ACTION_ID);
    expect(json).toContain("d-1");
    expect(json).toContain("Add login");
  });

  it("approved + error + help builders return non-empty blocks", () => {
    expect(buildApprovedBlocks("d-1").length).toBeGreaterThan(0);
    expect(JSON.stringify(buildApprovedBlocks("d-1"))).toContain("d-1");
    expect(buildErrorBlocks("Title", "Detail").length).toBe(2);
    expect(JSON.stringify(buildErrorBlocks("Title", "Detail"))).toContain("Detail");
    expect(JSON.stringify(buildHelpBlocks())).toContain("status");
  });

  it("budget-alert blocks render workspace, rule, utilisation, and dollar figures (#51)", () => {
    const blocks = buildBudgetAlertBlocks({
      workspaceName: "Acme",
      ruleName: "80% projected",
      thresholdPct: 80,
      basis: "projected",
      spendCents: 8_000,
      budgetCents: 10_000,
      ratio: 0.8,
      firedAt: "2026-07-01T00:00:00.000Z",
    });
    const json = JSON.stringify(blocks);
    expect(blocks.length).toBeGreaterThan(0);
    expect(json).toContain("Acme");
    expect(json).toContain("80% projected");
    expect(json).toContain("80%");
    expect(json).toContain("$80.00");
    expect(json).toContain("$100.00");
  });
});
