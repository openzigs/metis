/**
 * Epic #1608 (#1624) — the impact overview sentence of a portfolio summary.
 * Pure, with no imports beyond types, so the read-time view can use it without
 * loading the report generator (and the provider layer) into its import graph.
 */
import type { PortfolioCoverage, PortfolioImpactKind } from "@metis/shared";

/** A product row as the overview reads it. */
export interface OverviewRow {
  productId: string;
  coverage: PortfolioCoverage;
  impactKind: PortfolioImpactKind;
  via: string | null;
  severity: string | null;
}

/**
 * The impact in one or two plain sentences: what must change and what is
 * downstream. A product the reader cannot read is counted, never named.
 */
export function impactOverview(
  rows: readonly OverviewRow[],
  nameOf: (productId: string) => string | null,
): string {
  const named = (r: OverviewRow) => (r.coverage === "restricted" ? null : nameOf(r.productId));
  const direct = rows.filter((r) => r.impactKind === "direct-change" && named(r));
  const downstream = rows.filter((r) => r.impactKind === "downstream-consumer");
  const shown = downstream.filter((r) => named(r));
  const hidden = downstream.length - shown.length;
  const parts: string[] = [];
  if (direct.length > 0) parts.push(`Must change: ${direct.map((r) => named(r)).join(", ")}.`);
  if (shown.length > 0) {
    const detail = (r: OverviewRow) => {
      const tags = [r.via, r.severity].filter(Boolean).join(", ");
      return tags ? `${named(r)} (${tags})` : named(r);
    };
    parts.push(`Downstream: ${shown.map(detail).join("; ")}.`);
  }
  if (hidden > 0) {
    parts.push(
      `${hidden} downstream ${hidden === 1 ? "product is" : "products are"} restricted for this run.`,
    );
  }
  return parts.join(" ");
}
