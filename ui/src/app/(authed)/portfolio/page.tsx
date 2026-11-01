/**
 * Epic #1608 (#1626) — the business analyst's entry to the portfolio: type a
 * requirement (or arrive with an approved one), choose one product or every
 * product you can access, and see which product already covers it.
 *
 * Arrives from a product page with `?productId=` (that product starts chosen),
 * and from a requirement's detail with `?requirementId=&title=` (the title is
 * display-only; the server reads the requirement itself, with access).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ApiError } from "@/lib/api-client";
import { productsApi } from "@/lib/products-api";
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialProductId = searchParams?.get("productId") ?? null;
  const requirementId = searchParams?.get("requirementId") ?? null;
  const [requirement, setRequirement] = useState(() =>
    requirementId
      ? {
          id: requirementId,
          title: (searchParams?.get("title") ?? "").slice(0, TITLE_MAX) || "Selected requirement",
        }
      : null,
  );

  const productsQuery = useQuery({
    queryKey: ["portfolio", "products"],
    queryFn: () => productsApi.list({ limit: 100 }),
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
        initialProductId={initialProductId}
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
