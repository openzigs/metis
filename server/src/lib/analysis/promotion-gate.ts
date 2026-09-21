/**
 * Issue #1104 (finding B) — the single source of the approval gate's
 * user-facing wording.
 *
 * A run whose requirements are withheld by pending approvals must never present
 * as plain success, so the short summary (job-lifecycle message, status line)
 * and the long reason (analysis metadata, socket event, API response) are
 * derived here instead of being re-phrased at each call site.
 *
 * Deliberately its OWN module rather than living beside `canCreateTickets`:
 * `approval-checkpoint.js` is DB-backed and therefore mocked wholesale by the
 * pipeline suites, and a mock that omits one export would turn this pure string
 * helper into a crash on the blocked path.
 */
export interface PromotionGateCounts {
  pendingCount: number;
  rejectedCount: number;
  /** How many synthesized requirements the gate is holding back. */
  awaitingRequirementCount: number;
}

export function describePromotionGate(gate: PromotionGateCounts): {
  summary: string;
  reason: string;
} {
  const summary =
    gate.awaitingRequirementCount > 0
      ? `${gate.awaitingRequirementCount} requirement(s) awaiting approval`
      : "promotion awaiting approval";
  const parts: string[] = [];
  if (gate.pendingCount > 0) parts.push(`${gate.pendingCount} pending`);
  if (gate.rejectedCount > 0) parts.push(`${gate.rejectedCount} rejected`);
  const outstanding = parts.length > 0 ? parts.join(", ") : "unresolved";
  return {
    summary,
    reason: `Promotion blocked: ${summary}. Resolve ${outstanding} approval(s) to save them.`,
  };
}
