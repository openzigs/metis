/**
 * #2302 — how sure Impact Analysis is about an affected symbol or table, in the
 * portfolio check's words and colours (#2272): verified by graph path, likely,
 * possible or needs review. The tier itself is `impactSymbolTier` /
 * `impactTableTier` in `@metis/shared`, which the Markdown export calls too.
 */
"use client";

import { IMPACT_TIER_LABEL, type ImpactTier } from "@metis/shared";
import { Badge } from "@/components/ui/badge";

const TIER_VARIANT: Record<ImpactTier, "success" | "info" | "warning" | "outline"> = {
  verified: "success",
  likely: "info",
  possible: "warning",
  "needs-review": "outline",
};

export function ImpactTierBadge({ tier }: { tier: ImpactTier }) {
  return (
    <Badge variant={TIER_VARIANT[tier]} data-testid="impact-tier" data-tier={tier}>
      {IMPACT_TIER_LABEL[tier]}
    </Badge>
  );
}
