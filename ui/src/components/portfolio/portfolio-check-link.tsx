/**
 * Epic #1608 (#1626) — the way into the portfolio coverage page from a product
 * (that product starts chosen), from an approved requirement (it is the one
 * checked), or (#2272) from a document (each requirement read from it is
 * checked), or (#2345) from a change request (each of its draft and approved
 * requirements is checked), or (#2301) from requirements ticked on a project's
 * Requirements tab (each is checked on its own). The title travels for display only: the server
 * reads the requirement, document or change request itself, with the caller's
 * access.
 */
import Link from "next/link";
import { Network } from "lucide-react";
import { Button } from "@/components/ui/button";

const TITLE_MAX = 200;

export function portfolioCheckHref(
  from:
    | { productId: string }
    | { requirementId: string; title: string }
    | { documentId: string; title: string }
    | { analysisId: string; title: string; projectId?: string }
    | { requirementIds: string[]; title: string },
): string {
  if ("requirementIds" in from) {
    // #2301 — a chosen set: each id travels; the server reads each, with access.
    const params = new URLSearchParams();
    for (const id of from.requirementIds) params.append("requirementIds", id);
    params.set("title", from.title.slice(0, TITLE_MAX));
    return `/portfolio?${params.toString()}`;
  }
  const params =
    "productId" in from
      ? new URLSearchParams({ productId: from.productId })
      : "analysisId" in from
        ? // #2345 — a change request: the server reads its requirements itself.
          new URLSearchParams({
            analysisId: from.analysisId,
            title: from.title.slice(0, TITLE_MAX),
            // Only for the link back to it; the server reads the change request's own project.
            ...(from.projectId ? { projectId: from.projectId } : {}),
          })
        : "documentId" in from
          ? new URLSearchParams({
              documentId: from.documentId,
              title: from.title.slice(0, TITLE_MAX),
            })
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
