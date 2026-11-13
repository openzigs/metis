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
 * #2272 — `?documentId=&title=` arrives from a project's documents: each
 * requirement the document holds is checked (the title is display-only; the
 * server reads the document itself, with access). Several `productId`s start
 * "Several products" with each one chosen.
 *
 * #2353 — the Projects hub's one Portfolio tab: the coverage check, and the
 * products it checks across (the former `/products` page, which redirects here
 * with `?tab=products`). The check is the section a link with no `tab` opens.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MAX_PAGE_SIZE, type PortfolioAssessmentListItem } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api-client";
import { productsApi } from "@/lib/products-api";
import { queryKeys } from "@/lib/query-keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useCreatePortfolioAssessment, usePortfolioAssessments } from "@/lib/portfolio-hooks";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { ProductsPanel } from "@/components/portfolio/products-panel";
import { EmptyState } from "@/components/ui/empty-state";

const TITLE_MAX = 200;

type PortfolioTab = "coverage" | "products";

const TABS: ReadonlyArray<{ id: PortfolioTab; label: string }> = [
  { id: "coverage", label: "Coverage" },
  { id: "products", label: "Products" },
];

const VERDICT_LABEL: Record<string, string> = {
  implemented: "Covered",
  partial: "Partly covered",
  "gap-confirmed": "Nothing covers it",
  "could-not-verify": "Could not tell",
};

/**
 * #1749 — a recent check says whether a product was chosen to build it, so the
 * with-host and no-host runs of one statement do not read the same.
 */
function hostLabel(a: Pick<PortfolioAssessmentListItem, "hostProductId" | "hostProductName">) {
  if (!a.hostProductId) return "No product chosen to build it";
  return `Built by ${a.hostProductName ?? "the product chosen"}`;
}

type SearchParamsReader = { get(name: string): string | null; getAll?(name: string): string[] };

export default function PortfolioPage() {
  const searchParams = useSearchParams();
  const requested = searchParams?.get("tab") ?? null;
  // Keyed on `tab`, so a link naming another section (the hub tab's bare
  // `/portfolio`, say) opens it even while this page is already showing.
  return (
    <PortfolioSections key={requested ?? ""} requested={requested} searchParams={searchParams} />
  );
}

function PortfolioSections({
  requested,
  searchParams,
}: {
  requested: string | null;
  searchParams: SearchParamsReader | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<PortfolioTab>(
    TABS.find((t) => t.id === requested)?.id ?? "coverage",
  );

  // #2353 — the section is in the URL (`?tab=products`; Coverage is the bare
  // page), so browser Back from a product, a reload or a shared link reopens
  // it. Replaced, not pushed: switching sections adds no history entries.
  function selectTab(next: PortfolioTab) {
    setTab(next);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "coverage") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `/portfolio?${qs}` : "/portfolio", { scroll: false });
  }

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="portfolio-root">
      <PageHeader
        title="Portfolio"
        description="Your products, and whether one of them already does what a requirement asks, before anyone builds it again."
      />

      <Tabs value={tab} onValueChange={(v) => selectTab(v as PortfolioTab)}>
        <TabsList
          aria-label="Portfolio sections"
          className="flex h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0"
        >
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              data-testid={`portfolio-tab-${t.id}`}
              className="rounded-none border-b-2 border-transparent px-3 py-2 font-normal text-muted-foreground shadow-none hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="coverage">
          <PortfolioEntry key={searchParams?.toString() ?? ""} searchParams={searchParams} />
        </TabsContent>
        <TabsContent value="products">
          <ProductsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PortfolioEntry({ searchParams }: { searchParams: SearchParamsReader | null }) {
  const router = useRouter();
  const initialProductId = searchParams?.get("productId") ?? null;
  const initialProductIds = searchParams?.getAll?.("productId") ?? [];
  const requirementId = searchParams?.get("requirementId") ?? null;
  const documentId = searchParams?.get("documentId") ?? null;
  const [document, setDocument] = useState(() =>
    documentId
      ? {
          id: documentId,
          title: (searchParams?.get("title") ?? "").slice(0, TITLE_MAX) || "Selected document",
        }
      : null,
  );
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
    // #2353 — under the products key, so a product created (or changed) in the
    // Products section one click away is in this picker when Coverage reopens.
    queryKey: queryKeys.products.list({ picker: "portfolio", search }),
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
    <div className="space-y-6">
      <PortfolioAssessmentForm
        products={(productsQuery.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }))}
        productsLoading={productsQuery.isLoading}
        productQuery={productQuery}
        onProductQueryChange={setProductQuery}
        productTotal={productsQuery.data?.total}
        initialProductId={initialProductId}
        initialProductName={initialProduct.data?.name ?? null}
        initialProductIds={initialProductIds}
        initialStatement={initialStatement}
        requirement={requirement}
        onClearRequirement={() => setRequirement(null)}
        document={document}
        onClearDocument={() => setDocument(null)}
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
          <EmptyState data-testid="portfolio-recent-empty" title="No checks yet." />
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
                  · {a.productCount} product{a.productCount === 1 ? "" : "s"} · {hostLabel(a)} ·{" "}
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
