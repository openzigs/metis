"use client";

/**
 * Issue #2345 (epic #2328) — impact analysis and the portfolio check on the
 * change request's own page: started here with its requirements already
 * filled in (the server reads them; the analyst types nothing again), and
 * their results listed here, newest first, each a link to the full result.
 *
 * "Run impact analysis" runs over this change request's project with the
 * defaults, and "Run portfolio check" over every product the analyst can read:
 * neither offers a scope the analyst does not have, and the server checks the
 * change request and the scope again. "Options" opens the full form, pre-filled
 * the same way, to choose other projects or products. The portfolio check may
 * run before the requirements are approved; it is then labelled as run on
 * unapproved requirements, here and wherever else it is cited.
 *
 * The lists share their query keys with the step header, so the two read once
 * and never disagree. While a result is still running they are re-read every
 * {@link CHECKS_POLL_MS} (the portfolio reads share a 300-per-15-minutes limit).
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Network, Radar } from "lucide-react";
import {
  MAX_IMPACT_REQUIREMENT_IDS,
  NO_CODE_IMPACT_REASON,
  PORTFOLIO_PRE_APPROVAL_LABEL,
  type ImpactAnalysisSummary,
  type PortfolioAssessmentListItem,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { AnalysisSnapshot } from "@/lib/analysis-api";
import { impactAnalysisApi } from "@/lib/impact-analysis-api";
import { impactAnalysisKeys, useCreateImpactAnalysis } from "@/lib/impact-analysis-hooks";
import { portfolioApi } from "@/lib/portfolio-api";
import { portfolioKeys, useCreatePortfolioAssessment } from "@/lib/portfolio-hooks";
import { useCodeConnected } from "@/lib/use-code-connected";
import { portfolioCheckHref } from "@/components/portfolio/portfolio-check-link";
import { CHANGE_REQUEST_CHECKS_ID } from "@/components/analysis/change-request-steps";

/** How often the lists are re-read while a result is still running. */
export const CHECKS_POLL_MS = 5_000;

const STATUS_LABEL: Record<string, string> = {
  pending: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

const VERDICT_LABEL: Record<string, string> = {
  implemented: "Covered",
  partial: "Partly covered",
  "gap-confirmed": "Nothing covers it",
  "could-not-verify": "Could not tell",
};

const live = (status: string) => status === "pending" || status === "running";

/** The requirements a check of this change request reads: not rejected, not deferred. */
export function checkedRequirements(snapshot: Pick<AnalysisSnapshot, "requirements">): {
  count: number;
  unapproved: number;
} {
  const checked = snapshot.requirements.filter(
    (r) => r.reviewStatus !== "rejected" && r.reviewStatus !== "deferred",
  );
  return {
    count: checked.length,
    unapproved: checked.filter((r) => r.reviewStatus !== "approved").length,
  };
}

/**
 * #2345 — what an impact analysis of `count` requirements says it checks. One
 * run takes at most {@link MAX_IMPACT_REQUIREMENT_IDS} (the server keeps the
 * first, oldest ones), so a larger change request is told "the first 50 of N".
 */
export function impactCheckedCopy(count: number): string | null {
  return count > MAX_IMPACT_REQUIREMENT_IDS
    ? `An impact analysis checks the first ${MAX_IMPACT_REQUIREMENT_IDS} of the ${count}.`
    : null;
}

/** The "Options" links: the full forms, pre-filled from this change request. */
export function changeRequestFormHrefs(projectId: string, analysisId: string, title: string) {
  return {
    impact: `/impact-analyses/new?${new URLSearchParams({ projectId, analysisId }).toString()}`,
    portfolio: portfolioCheckHref({ analysisId, title, projectId }),
  };
}

interface Props {
  projectId: string;
  snapshot: AnalysisSnapshot;
  /** The change request's title, for the portfolio form's display. */
  title: string;
  /** The user holds `analysis.run`; the server enforces it either way. */
  canRun: boolean;
}

export function ChangeRequestChecks({ projectId, snapshot, title, canRun }: Props) {
  const analysisId = snapshot.id;
  const impacts = useQuery({
    queryKey: impactAnalysisKeys.changeRequestList(analysisId),
    queryFn: () => impactAnalysisApi.listForChangeRequest(analysisId),
    retry: false,
    refetchInterval: (q) =>
      Array.isArray(q.state.data) && q.state.data.some((r) => live(r.status))
        ? CHECKS_POLL_MS
        : false,
  });
  const checks = useQuery({
    queryKey: portfolioKeys.runList(analysisId),
    queryFn: () => portfolioApi.listForRun(analysisId),
    retry: false,
    refetchInterval: (q) =>
      Array.isArray(q.state.data) && q.state.data.some((r) => live(r.status))
        ? CHECKS_POLL_MS
        : false,
  });
  // #2454 — a Documents-only project: the one-click run would map no code, so
  // only Options (other projects) is offered, as the Impact step says.
  const codeConnected = useCodeConnected(projectId, snapshot);
  const runImpact = useCreateImpactAnalysis();
  const runPortfolio = useCreatePortfolioAssessment();

  const { count, unapproved } = checkedRequirements(snapshot);
  const nothing = count === 0;
  const hrefs = changeRequestFormHrefs(projectId, analysisId, title);

  return (
    <Card
      id={CHANGE_REQUEST_CHECKS_ID}
      className="scroll-mt-4 space-y-4 p-4"
      aria-labelledby="change-request-checks-heading"
      data-testid="change-request-checks"
    >
      <div className="space-y-1">
        <h3 id="change-request-checks-heading" className="text-sm font-semibold">
          Impact and portfolio
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="change-request-checks-source">
          {nothing
            ? "No draft or approved requirements to check yet."
            : `Checks this change request's ${count} requirement${count === 1 ? "" : "s"} (draft and approved; rejected and deferred ones are left out).`}
          {impactCheckedCopy(count) ? ` ${impactCheckedCopy(count)}` : ""}
          {!nothing && unapproved > 0
            ? ` ${unapproved} ${unapproved === 1 ? "is" : "are"} not approved yet: a portfolio check now is labelled as run on unapproved requirements.`
            : ""}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="change-request-impact-heading" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="change-request-impact-heading" className="text-sm font-medium">
              Impact analysis
            </h4>
            {canRun ? (
              <>
                {codeConnected ? (
                  <Button
                    size="sm"
                    disabled={nothing || runImpact.isPending}
                    onClick={() => runImpact.mutate({ analysisId, projectIds: [projectId] })}
                    data-testid="change-request-run-impact"
                  >
                    <Radar className="mr-1 h-3.5 w-3.5" aria-hidden />
                    {runImpact.isPending ? "Starting…" : "Run impact analysis"}
                  </Button>
                ) : null}
                {nothing ? null : (
                  <Link
                    href={hrefs.impact}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    data-testid="change-request-impact-options"
                  >
                    Options
                  </Link>
                )}
              </>
            ) : null}
          </div>
          {codeConnected ? null : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="change-request-impact-no-code"
            >
              {NO_CODE_IMPACT_REASON}
            </p>
          )}
          <ImpactResults query={impacts} />
        </section>

        <section aria-labelledby="change-request-portfolio-heading" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="change-request-portfolio-heading" className="text-sm font-medium">
              Portfolio check
            </h4>
            {canRun ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={nothing || runPortfolio.isPending}
                  onClick={() => runPortfolio.mutate({ analysisId, scope: "all-accessible" })}
                  data-testid="change-request-run-portfolio"
                >
                  <Network className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {runPortfolio.isPending ? "Starting…" : "Run portfolio check"}
                </Button>
                {nothing ? null : (
                  <Link
                    href={hrefs.portfolio}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    data-testid="change-request-portfolio-options"
                  >
                    Options
                  </Link>
                )}
              </>
            ) : null}
          </div>
          {runPortfolio.error ? (
            <p role="alert" className="text-xs text-destructive">
              Could not start the portfolio check. Try again.
            </p>
          ) : null}
          <PortfolioResults query={checks} />
        </section>
      </div>
    </Card>
  );
}

type ListQuery<T> = { isLoading: boolean; isError: boolean; data?: T[] };

function ImpactResults({ query }: { query: ListQuery<ImpactAnalysisSummary> }) {
  if (query.isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (query.isError || !Array.isArray(query.data))
    return <p className="text-xs text-muted-foreground">Could not load the impact analyses.</p>;
  if (query.data.length === 0)
    return (
      <p className="text-xs text-muted-foreground" data-testid="change-request-impact-empty">
        None run from this change request yet.
      </p>
    );
  return (
    <ol className="space-y-1" data-testid="change-request-impact-results">
      {query.data.map((r, i) => (
        <li key={r.id} className="text-xs" data-testid="change-request-impact-result">
          <Link href={`/impact-analyses/${encodeURIComponent(r.id)}`} className="hover:underline">
            {STATUS_LABEL[r.status] ?? r.status}
            {r.status === "completed"
              ? ` · ${r.totalImpactedSymbols} affected symbol${r.totalImpactedSymbols === 1 ? "" : "s"}`
              : ""}{" "}
            · {new Date(r.startedAt).toLocaleString()}
          </Link>
          {i === 0 ? (
            <Badge variant="secondary" className="ml-2">
              Latest
            </Badge>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function PortfolioResults({ query }: { query: ListQuery<PortfolioAssessmentListItem> }) {
  if (query.isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (query.isError || !Array.isArray(query.data))
    return <p className="text-xs text-muted-foreground">Could not load the portfolio checks.</p>;
  if (query.data.length === 0)
    return (
      <p className="text-xs text-muted-foreground" data-testid="change-request-portfolio-empty">
        None run from this change request yet.
      </p>
    );
  return (
    <ol className="space-y-1" data-testid="change-request-portfolio-results">
      {query.data.map((r, i) => (
        <li key={r.id} className="text-xs" data-testid="change-request-portfolio-result">
          <Link href={`/portfolio/${encodeURIComponent(r.id)}`} className="hover:underline">
            {r.status === "completed"
              ? (VERDICT_LABEL[r.verdict ?? ""] ?? "No answer")
              : (STATUS_LABEL[r.status] ?? r.status)}{" "}
            · {new Date(r.createdAt).toLocaleString()}
          </Link>
          {i === 0 ? (
            <Badge variant="secondary" className="ml-2">
              Latest
            </Badge>
          ) : null}
          {r.preApproval ? (
            <Badge variant="outline" className="ml-2" data-testid="portfolio-pre-approval">
              {PORTFOLIO_PRE_APPROVAL_LABEL}
            </Badge>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
