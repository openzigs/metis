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
    // #1668 — and the walk never goes through one, so say what it did not follow.
    parts.push(
      hidden === 1
        ? "1 downstream product is restricted for this run, so impact past it was not followed."
        : `${hidden} downstream products are restricted for this run, so impact past them was not followed.`,
    );
  }
  return parts.join(" ");
}

/**
 * One sentence on how a product is reached, for a product outside the gap
 * scope (#1623). Built from the row's own fields, so a row whose path is
 * withheld from a reader (#1668: `via` and `severity` null) says no more.
 */
export function impactSentence(p: Pick<OverviewRow, "impactKind" | "via" | "severity">): string {
  if (p.impactKind === "direct-change") return "Must change to deliver this requirement.";
  if (p.impactKind === "none") return "Not affected.";
  return `Downstream consumer${p.via ? ` via ${p.via}` : ""}${p.severity ? ` (${p.severity})` : ""}.`;
}
