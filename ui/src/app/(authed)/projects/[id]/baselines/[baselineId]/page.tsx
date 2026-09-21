"use client";

/**
 * Epic #609 / Issue #620 — /projects/[id]/baselines/[baselineId]
 *
 * Baseline detail: name, provenance (producing review or manual creator), and
 * every pinned requirement rendered AS OF its pinned version via the
 * RequirementVersion reconstruction — never the current state.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { baselinesApi } from "@/lib/baselines-api";
import { queryKeys } from "@/lib/query-keys";
import { BaselineItemsTable } from "@/components/baselines/BaselineItemsTable";

export default function BaselineDetailPage() {
  const params = useParams<{ id: string; baselineId: string }>();
  const projectId = String(params?.id ?? "");
  const baselineId = String(params?.baselineId ?? "");

  const detail = useQuery({
    queryKey: queryKeys.baselines.detail(baselineId),
    queryFn: () => baselinesApi.get(baselineId),
    enabled: baselineId !== "",
  });

  const baseline = detail.data?.baseline;
  const items = detail.data?.items ?? [];

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="baseline-detail">
      <Link
        href={`/projects/${projectId}/baselines`}
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        ← Back to baselines
      </Link>

      {detail.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading baseline…</p>
      ) : detail.isError || !baseline ? (
        <p className="text-sm text-destructive" role="alert">
          Failed to load baseline. It may not exist, or you may lack access.
        </p>
      ) : (
        <>
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{baseline.name}</h1>
            <p className="text-sm text-muted-foreground">
              {baseline.reviewRequest ? (
                <>
                  Created on approval of review{" "}
                  <Link
                    href={`/reviews/${baseline.reviewRequest.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {baseline.reviewRequest.title}
                  </Link>
                </>
              ) : (
                <>Created manually by {baseline.createdBy.displayName}</>
              )}{" "}
              · {new Date(baseline.createdAt).toLocaleString()} · immutable snapshot
            </p>
            {baseline.description ? (
              <p className="text-sm text-foreground/90">{baseline.description}</p>
            ) : null}
          </header>

          <section className="space-y-3" aria-label="Pinned requirements">
            <h2 className="text-sm font-semibold">
              Pinned requirements ({items.length}) — content as of the pinned version
            </h2>
            <BaselineItemsTable items={items} />
          </section>
        </>
      )}
    </div>
  );
}
