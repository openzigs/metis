"use client";

/**
 * #816 (Epic #812) — "Untested requirements" on the analysis Traceability tab.
 *
 * Lists the analysis's requirements that have mapped code but no linked test
 * (`GET /traceability/test-gaps`, #814), each linking to its requirement card,
 * with "Load more" paging through `nextCursor`. The summary is taken over the
 * requirements WITH mapped code: a requirement with no mapped code cannot be
 * told tested or untested, so it is counted separately and never listed.
 *
 * Named "Untested requirements" so it is never confused with `GapReport`
 * (#742), which reports *implementation* gaps.
 */
import * as React from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { traceabilityApi } from "@/lib/traceability-api";
import { Button } from "@/components/ui/button";

export const UNTESTED_PAGE_SIZE = 50;

interface Props {
  projectId: string;
  analysisId: string;
  /** Only fetch once the run has completed (the matrix's rule). */
  enabled?: boolean;
}

function requirementHref(projectId: string, analysisId: string, requirementId: string): string {
  // An explicit `tab=requirements` so a repeat click still lands on the card's
  // tab: the page's #424 deep-link effect applies once per requirement.
  const qs = new URLSearchParams({ analysisId, requirementId, tab: "requirements" });
  return `/projects/${encodeURIComponent(projectId)}/analysis?${qs.toString()}`;
}

export function UntestedRequirementsPanel({
  projectId,
  analysisId,
  enabled = true,
}: Props): React.ReactElement | null {
  const query = useInfiniteQuery({
    queryKey: ["traceability-test-gaps", projectId, analysisId],
    queryFn: ({ pageParam }) =>
      traceabilityApi.testGaps(projectId, {
        analysisId,
        limit: UNTESTED_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });

  if (!enabled) return null;

  const headingId = `untested-requirements-${analysisId}`;
  const first = query.data?.pages[0];
  const untested = (query.data?.pages ?? [])
    .flatMap((p) => p.untested)
    .filter((g) => g.reason === "no-test");

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading untested requirements…
      </p>
    );
  } else if (!first) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        Could not load untested requirements.
      </p>
    );
  } else {
    const withCode = first.total - first.noCode;
    body = (
      <>
        {withCode > 0 ? (
          <p data-testid="untested-summary" className="text-sm">
            {first.tested} of {withCode} requirements with mapped code have a linked test
          </p>
        ) : null}
        {first.noCode > 0 && withCode > 0 ? (
          <p data-testid="untested-no-code" className="text-xs text-muted-foreground">
            {first.noCode === 1
              ? "1 requirement has no mapped code yet, so it is not counted"
              : `${first.noCode} requirements have no mapped code yet, so they are not counted`}
          </p>
        ) : null}
        {untested.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {untested.map((g) => (
              <li key={g.requirementId} className="p-2">
                <Link
                  href={requirementHref(projectId, analysisId, g.requirementId)}
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  {g.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="untested-empty" className="text-sm text-muted-foreground">
            {withCode > 0
              ? "Every requirement with mapped code has a linked test."
              : "No requirement has mapped code yet, so none can be checked for tests."}
          </p>
        )}
        {query.isFetchNextPageError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load more untested requirements. Try again.
          </p>
        ) : null}
        {query.hasNextPage ? (
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <section
      data-testid="untested-requirements-panel"
      aria-labelledby={headingId}
      className="space-y-2"
    >
      <div>
        <h4
          id={headingId}
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Untested requirements
        </h4>
        <p className="text-xs text-muted-foreground">
          Requirements whose mapped code has no linked test.
        </p>
      </div>
      {body}
    </section>
  );
}
