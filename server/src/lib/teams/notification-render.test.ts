/**
 * Issue #67 — notification card renderer tests (pure formatter).
 *
 * Proves: each of the three card builders produces a `message` activity with a
 * text fallback + a single Adaptive Card attachment (correct content-type), the
 * expected facts appear, optional facts are omitted when absent, oversized fields
 * are clamped, and the cards carry NO actions (one-way, not interactive).
 */
import { describe, expect, it } from "vitest";

import {
  renderAnalysisCompleteCard,
  renderPublishRolledBackCard,
  renderBudgetExceededCard,
  formatCents,
} from "./notification-render.js";

const ADAPTIVE = "application/vnd.microsoft.card.adaptive";

function cardOf(activity: { attachments?: { contentType: string; content: unknown }[] }) {
  expect(activity.attachments).toHaveLength(1);
  expect(activity.attachments?.[0].contentType).toBe(ADAPTIVE);
  return activity.attachments?.[0].content as {
    body: { type: string; text?: string; facts?: { title: string; value: string }[] }[];
    actions?: unknown[];
  };
}

function facts(card: ReturnType<typeof cardOf>): Record<string, string> {
  const fs = card.body.find((b) => b.type === "FactSet");
  const out: Record<string, string> = {};
  for (const f of fs?.facts ?? []) out[f.title] = f.value;
  return out;
}

describe("notification-render (#67)", () => {
  describe("formatCents", () => {
    it("formats cents as USD", () => {
      expect(formatCents(0)).toBe("$0.00");
      expect(formatCents(12345)).toBe("$123.45");
      expect(formatCents(100)).toBe("$1.00");
    });
  });

  describe("analysis-complete", () => {
    it("renders a card + text fallback with the project and counts", () => {
      const a = renderAnalysisCompleteCard({
        projectName: "Acme Portal",
        analysisId: "an-1",
        requirementCount: 12,
        findingCount: 3,
      });
      expect(a.type).toBe("message");
      expect(a.text).toContain("Acme Portal");
      const card = cardOf(a);
      const f = facts(card);
      expect(f.Project).toBe("Acme Portal");
      expect(f.Requirements).toBe("12");
      expect(f.Findings).toBe("3");
      // One-way: no actions.
      expect(card.actions ?? []).toHaveLength(0);
    });

    it("omits optional counts when not provided", () => {
      const a = renderAnalysisCompleteCard({ projectName: "P", analysisId: "an-2" });
      const f = facts(cardOf(a));
      expect(f.Project).toBe("P");
      expect(f.Requirements).toBeUndefined();
      expect(f.Findings).toBeUndefined();
    });
  });

  describe("publish-rolled-back", () => {
    it("renders the reason and optional repo", () => {
      const a = renderPublishRolledBackCard({
        projectName: "Acme",
        batchId: "b-1",
        reason: "auto-rollback: 3/5 drafts failed",
        repo: "acme/portal",
      });
      expect(a.text).toContain("rolled back");
      const f = facts(cardOf(a));
      expect(f.Project).toBe("Acme");
      expect(f.Reason).toBe("auto-rollback: 3/5 drafts failed");
      expect(f.Repository).toBe("acme/portal");
    });

    it("omits the repo fact when absent", () => {
      const a = renderPublishRolledBackCard({ projectName: "Acme", batchId: "b", reason: "r" });
      expect(facts(cardOf(a)).Repository).toBeUndefined();
    });
  });

  describe("budget-exceeded", () => {
    it("renders spend/budget, utilization percent and basis", () => {
      const a = renderBudgetExceededCard({
        workspaceName: "Eng",
        ruleName: "90% projected",
        basis: "projected",
        spendCents: 11200,
        budgetCents: 10000,
        ratio: 1.12,
      });
      expect(a.text).toContain("112%");
      const f = facts(cardOf(a));
      expect(f.Workspace).toBe("Eng");
      expect(f.Rule).toBe("90% projected");
      expect(f.Basis).toBe("projected");
      expect(f.Spend).toBe("$112.00 of $100.00");
      expect(f.Utilization).toBe("112%");
    });
  });

  it("clamps an oversized field so the send never throws on length", () => {
    const huge = "x".repeat(5000);
    const a = renderPublishRolledBackCard({ projectName: "P", batchId: "b", reason: huge });
    const f = facts(cardOf(a));
    expect(f.Reason.length).toBeLessThanOrEqual(512);
    expect(f.Reason.endsWith("…")).toBe(true);
  });
});
