/**
 * Epic #1608 (#1626) — the way into the portfolio coverage page from a product
 * (that product starts chosen) or from an approved requirement (it is the one
 * checked). The title travels for display only: the server reads the
 * requirement itself, with the caller's access.
 */
import Link from "next/link";
import { Network } from "lucide-react";
import { Button } from "@/components/ui/button";

const TITLE_MAX = 200;

export function portfolioCheckHref(
  from: { productId: string } | { requirementId: string; title: string },
): string {
  const params =
    "productId" in from
      ? new URLSearchParams({ productId: from.productId })
      : new URLSearchParams({
          requirementId: from.requirementId,
          title: from.title.slice(0, TITLE_MAX),
        });
  return `/portfolio?${params.toString()}`;
}

export function PortfolioCheckLink({
  from,
  label = "Check across portfolio",
}: {
  from: Parameters<typeof portfolioCheckHref>[0];
  label?: string;
}) {
  return (
    <Button asChild size="sm" variant="outline" data-testid="portfolio-check-link">
      <Link href={portfolioCheckHref(from)}>
        <Network className="mr-1 h-3.5 w-3.5" aria-hidden />
        {label}
      </Link>
    </Button>
  );
}
