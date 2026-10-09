import type { AgentRunSummary } from "@/lib/runs-api";

/**
 * #977 — a run's cost from its unrounded ledger `costUsd`, rounded only here,
 * to display precision. The whole-cent `costCents` turned a 0.3¢ chat turn
 * into "—" and a 0.51¢ one into $0.0100; it is the fallback when `costUsd` is
 * absent. A run with no attributed cost reads "—", never "$0.0000".
 */
export function formatRunCost(r: Pick<AgentRunSummary, "costCents" | "costUsd">): string {
  const usd = r.costUsd ?? (r.costCents != null ? r.costCents / 100 : null);
  return usd != null && usd > 0 ? `$${usd.toFixed(4)}` : "—";
}
