/**
 * Issue #723 — the promotion gate's wording. A rejected approval is resolved
 * (the rejected requirement is left out), so only pending approvals may be
 * named as what must be resolved.
 */
import { describe, expect, it } from "vitest";
import { describePromotionGate } from "./promotion-gate.js";

describe("describePromotionGate", () => {
  it("names only the pending approvals as outstanding", () => {
    const { summary, reason } = describePromotionGate({
      pendingCount: 2,
      awaitingRequirementCount: 14,
    });
    expect(summary).toBe("14 requirement(s) awaiting approval");
    expect(reason).toBe(
      "Promotion blocked: 14 requirement(s) awaiting approval. Resolve 2 pending approval(s) to save them.",
    );
  });

  it("never names a rejection as outstanding, even when the caller's gate carries one", () => {
    const gate = { pendingCount: 1, rejectedCount: 3, awaitingRequirementCount: 5 };
    const { reason } = describePromotionGate(gate);
    expect(reason).not.toMatch(/rejected/);
    expect(reason).toContain("Resolve 1 pending approval(s)");
  });

  it("falls back to generic wording with no counts", () => {
    const { summary, reason } = describePromotionGate({
      pendingCount: 0,
      awaitingRequirementCount: 0,
    });
    expect(summary).toBe("promotion awaiting approval");
    expect(reason).toBe(
      "Promotion blocked: promotion awaiting approval. Resolve the pending approval(s) to save them.",
    );
  });
});
