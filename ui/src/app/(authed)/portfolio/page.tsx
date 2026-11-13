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
 * #2345 — `?analysisId=&title=` arrives from a change request: each of its
 * draft and approved requirements is checked, before approval too (labelled).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  MAX_PAGE_SIZE,
  PORTFOLIO_PRE_APPROVAL_LABEL,
  type PortfolioAssessmentListItem,
} from "@metis/shared";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ApiError } from "@/lib/api-client";
import { productsApi } from "@/lib/products-api";
import { projectsApi } from "@/lib/projects-api";
import { useValidatedActiveWorkspaceId, workspaceListQuery } from "@/lib/active-workspace";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useCreatePortfolioAssessment, usePortfolioAssessments } from "@/lib/portfolio-hooks";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { EmptyState } from "@/components/ui/empty-state";
import { ChangeRequestBackLink } from "@/components/analysis/change-request-back-link";

const TITLE_MAX = 200;

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

export default function PortfolioPage() {
  const searchParams = useSearchParams();
  return <PortfolioEntry key={searchParams?.toString() ?? ""} searchParams={searchParams} />;
}

function PortfolioEntry({
  searchParams,
}: {
  searchParams: { get(name: string): string | null; getAll?(name: string): string[] } | null;
}) {
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
  // #2345 — `?analysisId=&title=&projectId=` arrives from a change request: each
  // of its draft and approved requirements is checked (the title is
  // display-only; the server reads the change request itself, with access), and
  // `projectId` is only where the link back goes.
  const analysisId = searchParams?.get("analysisId") ?? null;
  const backProjectId = searchParams?.get("projectId") ?? null;
  const [changeRequest, setChangeRequest] = useState(() =>
    analysisId
      ? {
          id: analysisId,
          title:
            (searchParams?.get("title") ?? "").slice(0, TITLE_MAX) || "Selected change request",
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
  // #2351 — the shared scope picker. "This project": the product of the
  // project it was opened from (a change request's), named; a project in no
  // product says so rather than being silently out of scope (#2330).
  const project = useQuery({
    queryKey: ["portfolio", "project", backProjectId],
    queryFn: () => projectsApi.get(encodeURIComponent(backProjectId as string)),
    enabled: backProjectId !== null,
    retry: false,
  });
  const projectProductId = project.data?.productId ?? null;
  const projectProduct = useQuery({
    queryKey: ["portfolio", "product", projectProductId],
    queryFn: () => productsApi.get(encodeURIComponent(projectProductId as string)),
    enabled: projectProductId !== null,
    retry: false,
  });
  const current = projectProduct.data
    ? { id: projectProduct.data.id, name: projectProduct.data.name }
    : null;
  // Until the project and its product are read, the form holds its default and
  // its submit: a quick submit would otherwise go out over every product.
  const currentLoading =
    backProjectId !== null &&
    (project.isPending || (projectProductId !== null && projectProduct.isPending));
  const currentNote = !backProjectId
    ? "Open this from a change request to check its project's product."
    : currentLoading
      ? "Looking up this project's product…"
      : project.isError
        ? "Could not read this project, so its product is not offered."
        : !projectProductId
          ? `${project.data?.name ?? "This project"} is not part of a product, so it is not in the portfolio.`
          : projectProduct.isError
            ? "Could not read this project's product, so it is not offered."
            : undefined;
  // #2351 — "Whole workspace": the top bar's workspace's products the analyst
  // can read (the list is access-filtered on the server).
  const { workspaceId: activeWorkspaceId, status: workspaceStatus } =
    useValidatedActiveWorkspaceId();
  const { data: workspaces = [] } = useQuery(workspaceListQuery);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const workspaceProducts = useQuery({
    queryKey: ["portfolio", "workspace-products", activeWorkspace?.id ?? null],
    queryFn: () => productsApi.list({ pageSize: MAX_PAGE_SIZE, workspaceId: activeWorkspace!.id }),
    enabled: activeWorkspace !== null,
    retry: false,
  });
  const workspace =
    activeWorkspace && workspaceProducts.isSuccess
      ? {
          id: activeWorkspace.id,
          name: activeWorkspace.name,
          products: workspaceProducts.data.items.map((p) => ({ id: p.id, name: p.name })),
          count: workspaceProducts.data.total,
        }
      : undefined;
  // With a workspace open, "Whole workspace" waits for its products: while
  // they load, or when they cannot be read, it is disabled and says why, never
  // silently every product the analyst can read.
  const workspaceNote =
    workspaceStatus === "loading"
      ? "Loading your workspaces…"
      : workspaceStatus === "error"
        ? "Could not read your workspaces."
        : !activeWorkspace
          ? undefined
          : workspaceProducts.isError
            ? "Could not read the workspace's products."
            : workspaceProducts.isSuccess
              ? undefined
              : "Loading the workspace's products…";
  // #2351 — "every product you can read" counts all of them, not the search's
  // matches: the unsearched list, shared with the picker's own first page.
  const allProducts = useQuery({
    queryKey: ["portfolio", "products", ""],
    queryFn: () => productsApi.list({ pageSize: MAX_PAGE_SIZE }),
    enabled: activeWorkspace === null,
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
        eyebrow={
          analysisId && backProjectId ? (
            <ChangeRequestBackLink
              changeRequest={{
                id: analysisId,
                projectId: backProjectId,
                title: changeRequest?.title ?? "Selected change request",
              }}
              className="text-xs text-muted-foreground hover:underline"
              testId="portfolio-back-to-change-request"
            />
          ) : undefined
        }
        title="Portfolio coverage"
        description="Check whether a product in your portfolio already does what a requirement asks, before anyone builds it again."
      />

      <PortfolioAssessmentForm
        products={(productsQuery.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }))}
        productsLoading={productsQuery.isLoading}
        productQuery={productQuery}
        onProductQueryChange={setProductQuery}
        productTotal={productsQuery.data?.total}
        allProductTotal={allProducts.data?.total}
        initialProductId={initialProductId}
        initialProductName={initialProduct.data?.name ?? null}
        initialProductIds={initialProductIds}
        initialStatement={initialStatement}
        requirement={requirement}
        onClearRequirement={() => setRequirement(null)}
        document={document}
        onClearDocument={() => setDocument(null)}
        changeRequest={changeRequest}
        onClearChangeRequest={() => setChangeRequest(null)}
        current={current}
        currentNote={currentNote}
        scopeLoading={currentLoading}
        workspace={workspace}
        workspaceNote={workspaceNote}
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
                  {/* #2345 — a check before approval says so wherever it is cited. */}
                  {a.preApproval ? ` · ${PORTFOLIO_PRE_APPROVAL_LABEL}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
