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
  /** #1963 — the other edge kinds the change reaches it by (`portfolioOtherLinkKinds`). */
  otherVia?: readonly string[];
}

/**
 * The impact in one or two plain sentences: what must change and what is
 * downstream. A product the reader cannot read is counted, never named.
 *
 * #1673 — a readable product whose impact runs, or may run, through one the
 * reader cannot read (`restricted` impact) is named as such. Nothing says the
 * walk "was not followed": that was true only of the run, and a narrower
 * reader's restricted product may be one the run walked through.
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
  const behind = rows.filter((r) => r.impactKind === "restricted" && named(r));
  const parts: string[] = [];
  if (direct.length > 0) parts.push(`Must change: ${direct.map((r) => named(r)).join(", ")}.`);
  if (shown.length > 0) {
    const detail = (r: OverviewRow) => {
      const tags = [r.via, r.severity].filter(Boolean).join(", ");
      // #1963 — the path shown is the most severe link; every other edge kind is named too.
      const also = r.otherVia && r.otherVia.length > 0 ? `also ${r.otherVia.join(", ")}` : "";
      const all = [tags, also].filter(Boolean).join("; ");
      return all ? `${named(r)} (${all})` : named(r);
    };
    parts.push(`Downstream: ${shown.map(detail).join("; ")}.`);
  }
  if (hidden > 0) {
    parts.push(
      hidden === 1
        ? "1 downstream product is restricted, so it is not named."
        : `${hidden} downstream products are restricted, so they are not named.`,
    );
  }
  if (behind.length > 0) {
    parts.push(
      `Restricted: ${behind.map((r) => named(r)).join(", ")} may be reached through a restricted product, so ${behind.length === 1 ? "its impact is" : "their impact is"} not shown.`,
    );
  }
  return parts.join(" ");
}

/**
 * One sentence on how a product is reached, for a product outside the gap
 * scope (#1623). Built from the row's own fields, so a row whose path is
 * withheld from a reader (#1668: `via` and `severity` null) says no more.
 */
export function impactSentence(
  p: Pick<OverviewRow, "impactKind" | "via" | "severity">,
  otherVia: readonly string[] = [],
): string {
  if (p.impactKind === "direct-change") return "Must change to deliver this requirement.";
  if (p.impactKind === "none") return "Not affected.";
  // #1673 — reached, or maybe reached, through a product the reader cannot read.
  if (p.impactKind === "restricted") return "May be reached through a restricted product.";
  // #1963 — every other edge kind the change reaches it by.
  const also = otherVia.length > 0 ? ` Also via ${otherVia.join(", ")}.` : "";
  return `Downstream consumer${p.via ? ` via ${p.via}` : ""}${p.severity ? ` (${p.severity})` : ""}.${also}`;
}
