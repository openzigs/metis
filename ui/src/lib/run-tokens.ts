/**
 * Issue #1007 — one way to show a run's tokens, on every surface that shows
 * them: the analysis page's run list and run header, `/runs` and a run's page.
 *
 * They used to read three different numbers for one run (215.4k in the list,
 * 479.8k in the header, a third in the ledger): the list read the total stored
 * when the run finished, the header summed the ledger with cache reads, and the
 * ledger query summed input and output only. Every surface now reads the
 * ledger's two figures and names both.
 */
import type { LedgerTokens } from "@metis/shared";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** `457.9k tok without cache · 545.2k with cache`. */
export function formatLedgerTokens(tokens: LedgerTokens): string {
  return `${formatTokens(tokens.withoutCache)} tok without cache · ${formatTokens(tokens.withCache)} with cache`;
}

export interface RunTokensInput {
  /**
   * The run's ledger tokens. `null` or absent means the ledger COULD NOT BE
   * READ; zero figures mean it was read and holds no row for the run.
   */
  tokens?: LedgerTokens | null;
  /** The total stored when the run finished: 0 until then. */
  storedTotal?: number | null;
  status?: string | null;
}

/**
 * A run's tokens:
 *   • the ledger's figures once it holds any, which move while the run goes;
 *   • `in progress` for a run that is going and has no ledger row yet — never
 *     "0 tok", which read as a run that spent nothing;
 *   • otherwise the total stored at finish, said to be that, with the REASON
 *     the ledger's figure is not shown: `not in the ledger` when the ledger was
 *     read and has no row (a run from before analysis spend was metered), or
 *     `ledger unavailable` when it could not be read — its rows may well be
 *     there (review of #1112: both used to read "not in the ledger").
 */
export function runTokensLabel(run: RunTokensInput): string {
  if (run.tokens && run.tokens.withCache > 0) return formatLedgerTokens(run.tokens);
  if (run.status === "running" || run.status === "pending") return "in progress";
  const ledgerRead = run.tokens != null;
  const stored = run.storedTotal ?? 0;
  if (stored > 0) {
    return `${formatTokens(stored)} tok recorded at finish (${ledgerRead ? "not in the ledger" : "ledger unavailable"})`;
  }
  return ledgerRead ? "0 tok" : "ledger unavailable";
}

/**
 * The note under a finished analysis run's tokens when part of them was
 * recorded after it finished (a deep dive, a regenerate, a clarification
 * round): "includes 339.8k tok without cache · 393.2k with cache recorded
 * after the run finished". `null` when there is none.
 */
export function tokensAfterRunNote(after: LedgerTokens | null | undefined): string | null {
  if (!after || after.withCache <= 0) return null;
  return `includes ${formatLedgerTokens(after)} recorded after the run finished`;
}
