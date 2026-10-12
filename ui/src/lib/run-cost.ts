import type { AgentRunSummary } from "@/lib/runs-api";
import { formatTokens } from "@/lib/run-tokens";

/**
 * The column header for every cost on `/runs` and a run's page. The figure is
 * the usage ledger's STORED cost — what each call was priced at when it was
 * recorded — the same one the usage pages and the analysis header sum. It is
 * not the tokens at today's rate card (review of #1112: the runs table used to
 * be that, next to a chat-turn table that was not, under one bare "Cost").
 */
export const RECORDED_COST_HEADER = "Cost (as recorded)";

/**
 * #977 — a cost from its unrounded ledger `costUsd`, rounded only here, to
 * display precision. The whole-cent `costCents` turned a 0.3¢ chat turn into
 * "—" and a 0.51¢ one into $0.0100; it is the fallback when `costUsd` is
 * absent. No attributed cost reads "—", never "$0.0000".
 *
 * Tokens the ledger holds UNPRICED (#22) are said to be that, next to the cost
 * of the priced ones or alone: "$1.5000 + 100.0k unpriced tok", "100.0k
 * unpriced tok". They are never priced here, and never shown as $0.
 */
export function formatRunCost(
  r: Pick<AgentRunSummary, "costCents" | "costUsd"> & { unpricedTokens?: number | null },
): string {
  const usd = r.costUsd ?? (r.costCents != null ? r.costCents / 100 : null);
  const cost = usd != null && usd > 0 ? `$${usd.toFixed(4)}` : null;
  const unpriced =
    r.unpricedTokens != null && r.unpricedTokens > 0
      ? `${formatTokens(r.unpricedTokens)} unpriced tok`
      : null;
  if (cost && unpriced) return `${cost} + ${unpriced}`;
  return cost ?? unpriced ?? "—";
}
