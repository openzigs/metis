/**
 * Epic #1608 (#1626) — the business analyst's entry to the portfolio: type a
 * requirement (or arrive with an approved one), choose one product or every
 * product you can access, and see which product already covers it.
 *
 * Arrives from a product page with `?productId=` (that product starts chosen),
 * and from a requirement's detail with `?requirementId=&title=` (the title is
 * display-only; the server reads the requirement itself, with access).
 *
 * #1673 — the form is keyed on the search params, so arriving at this page
 * again with other ones (a client navigation keeps the component mounted)
 * starts it afresh: it can never submit the requirement or product it was
 * first given. The product picker searches every product the analyst can
 * read, a page at a time, rather than showing only the first page.
 * #1680 — the product it arrived with is read by id, so it is named even when
 * it is not on the first page of the list.
 * #1725 — `?statement=` starts the form with a statement typed already: a
 * check whose impact needed a host product links back here to choose one.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MAX_PAGE_SIZE } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ApiError } from "@/lib/api-client";
import { productsApi } from "@/lib/products-api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useCreatePortfolioAssessment, usePortfolioAssessments } from "@/lib/portfolio-hooks";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";

const TITLE_MAX = 200;

const VERDICT_LABEL: Record<string, string> = {
  implemented: "Covered",
  partial: "Partly covered",
  "gap-confirmed": "Nothing covers it",
  "could-not-verify": "Could not tell",
};

export default function PortfolioPage() {
  const searchParams = useSearchParams();
  return <PortfolioEntry key={searchParams?.toString() ?? ""} searchParams={searchParams} />;
}

function PortfolioEntry({
  searchParams,
}: {
  searchParams: { get(name: string): string | null } | null;
}) {
  const router = useRouter();
  const initialProductId = searchParams?.get("productId") ?? null;
  const requirementId = searchParams?.get("requirementId") ?? null;
  const initialStatement = searchParams?.get("statement") ?? "";
  const [requirement, setRequirement] = useState(() =>
    requirementId
      ? {
          id: requirementId,
          title: (searchParams?.get("title") ?? "").slice(0, TITLE_MAX) || "Selected requirement",
        }
      : null,
  );

  const [productQuery, setProductQuery] = useState("");
  const search = useDebouncedValue(productQuery.trim(), 300);
  const productsQuery = useQuery({
    queryKey: ["portfolio", "products", search],
    queryFn: () =>
      productsApi.list(search ? { pageSize: MAX_PAGE_SIZE, search } : { pageSize: MAX_PAGE_SIZE }),
    retry: false,
    placeholderData: keepPreviousData,
  });
  // #1680 — the product arrived with may be past the first page: read its name.
  // #1685 — only once the page is in and does not hold it.
  const listed = (productsQuery.data?.items ?? []).some((p) => p.id === initialProductId);
  const initialProduct = useQuery({
    queryKey: ["portfolio", "product", initialProductId],
    // The id is from the URL: encoded, so it can only name a product.
    queryFn: () => productsApi.get(encodeURIComponent(initialProductId as string)),
    enabled: initialProductId !== null && !productsQuery.isPending && !listed,
    retry: false,
  });
  const recent = usePortfolioAssessments(initialProductId ?? undefined);
  const create = useCreatePortfolioAssessment();

  const error = create.error
    ? create.error instanceof ApiError
      ? create.error.message
      : "Could not start the check. Try again."
    : null;

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="portfolio-root">
      <PageHeader
        title="Portfolio coverage"
        description="Check whether a product in your portfolio already does what a requirement asks, before anyone builds it again."
      />

      <PortfolioAssessmentForm
        products={(productsQuery.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }))}
        productsLoading={productsQuery.isLoading}
        productQuery={productQuery}
        onProductQueryChange={setProductQuery}
        productTotal={productsQuery.data?.total}
        initialProductId={initialProductId}
        initialProductName={initialProduct.data?.name ?? null}
        initialStatement={initialStatement}
        requirement={requirement}
        onClearRequirement={() => setRequirement(null)}
        pending={create.isPending}
        error={error}
        onSubmit={(input) =>
          create.mutate(input, { onSuccess: (res) => router.push(`/portfolio/${res.id}`) })
        }
      />

      <section className="space-y-2" aria-labelledby="portfolio-recent-heading">
        <h2 id="portfolio-recent-heading" className="text-base font-semibold">
          Recent checks
        </h2>
        {recent.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading recent checks…</p>
        ) : recent.isError ? (
          <Card className="border-destructive p-4 text-sm text-destructive">
            Could not load recent checks.
          </Card>
        ) : (recent.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="portfolio-recent-empty">
            No checks yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(recent.data ?? []).map((a) => (
              <li key={a.id} className="p-3 text-sm" data-testid="portfolio-recent-item">
                <Link href={`/portfolio/${a.id}`} className="font-medium hover:underline">
                  {a.statement.length > 140 ? `${a.statement.slice(0, 140)}…` : a.statement}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {a.status === "completed"
                    ? (VERDICT_LABEL[a.verdict ?? ""] ?? "No answer")
                    : a.status === "failed"
                      ? "Failed"
                      : "Running"}{" "}
                  · {a.productCount} product{a.productCount === 1 ? "" : "s"} ·{" "}
                  {new Date(a.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
