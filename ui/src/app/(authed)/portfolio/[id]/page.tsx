/**
 * Epic #1608 (#1626, #1627) — one portfolio check: the answer first, then the
 * business-analyst summary, every product in scope with its coverage state
 * (and, for a covering or partial one, its repo-stamped citations), and the
 * cross-product impact with a technical deep dive per product.
 *
 * Everything shown is read from `GET /portfolio-assessments/:id`, never from
 * the form that started it, so a reload mid-run resumes the same assessment.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import type { PortfolioAssessmentView } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { portfolioApi } from "@/lib/portfolio-api";
import { triggerDownload } from "@/lib/plugins-api";
import { isTerminalStatus, usePortfolioAssessment } from "@/lib/portfolio-hooks";
import { coverageHeadline, coverageRows } from "@/lib/portfolio-coverage";
import { impactGroups } from "@/lib/portfolio-impact";
import { PortfolioCoverageHeadline } from "@/components/portfolio/portfolio-coverage-headline";
import { PortfolioCoverageMatrix } from "@/components/portfolio/portfolio-coverage-matrix";
import { PortfolioAssessmentProgress } from "@/components/portfolio/portfolio-assessment-progress";
import { PortfolioBaSummary } from "@/components/portfolio/portfolio-ba-summary";
import { PortfolioImpactView } from "@/components/portfolio/portfolio-impact-view";

/** #1627 — the #1624 Markdown export; off until the run has finished. */
function ExportButton({ view }: { view: PortfolioAssessmentView }) {
  const exportMutation = useMutation({
    mutationFn: () => portfolioApi.exportMarkdown(view.id),
    onSuccess: ({ blob, filename }) => triggerDownload(blob, filename),
  });
  const running = !isTerminalStatus(view.status);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        data-testid="portfolio-export-md"
        disabled={running || exportMutation.isPending}
        title={running ? "Available once the check has finished" : undefined}
        onClick={() => exportMutation.mutate()}
      >
        {exportMutation.isPending ? "Exporting…" : "Export Markdown"}
      </Button>
      {exportMutation.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not export this check.
        </p>
      ) : null}
    </div>
  );
}

export default function PortfolioAssessmentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { query, job } = usePortfolioAssessment(id);
  const view = query.data;

  const back = (
    <Link href="/portfolio" className="hover:underline">
      ← Back to portfolio coverage
    </Link>
  );

  if (query.isLoading) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="portfolio-detail-loading">
        Loading the check…
      </p>
    );
  }
  if (query.isError || !view) {
    return (
      <Card
        className="m-2 border-destructive p-4 text-sm text-destructive"
        data-testid="portfolio-detail-error"
      >
        Could not load this check. It may not exist, or you may not have access to it.
      </Card>
    );
  }

  const headline = coverageHeadline(view);
  const rows = coverageRows(view);
  const running = !isTerminalStatus(view.status);
  const impact = view.status === "completed" ? impactGroups(view) : null;

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="portfolio-detail-root">
      <PageHeader
        eyebrow={back}
        title="Portfolio coverage"
        actions={<ExportButton view={view} />}
      />

      <section aria-labelledby="portfolio-statement-heading" className="space-y-1">
        <h2 id="portfolio-statement-heading" className="text-sm font-medium text-muted-foreground">
          Requirement
        </h2>
        <p className="whitespace-pre-wrap text-sm" data-testid="portfolio-detail-statement">
          {view.statement}
        </p>
      </section>

      {running ? <PortfolioAssessmentProgress status={view.status} job={job} /> : null}
      {headline ? <PortfolioCoverageHeadline headline={headline} /> : null}
      {view.status === "completed" ? <PortfolioBaSummary view={view} /> : null}

      <section aria-labelledby="portfolio-matrix-heading" className="space-y-2">
        <h2 id="portfolio-matrix-heading" className="text-base font-semibold">
          Products checked
        </h2>
        {rows.length > 0 ? (
          <PortfolioCoverageMatrix rows={rows} />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="portfolio-matrix-empty">
            {running
              ? "The products in scope are listed as soon as the check has found them."
              : "No products were in scope."}
          </p>
        )}
      </section>

      {impact ? (
        <PortfolioImpactView affected={impact.affected} notAffected={impact.notAffected} />
      ) : null}
    </div>
  );
}
