"use client";

/**
 * Epic #609 / Issue #620 — /projects/[id]/baselines
 *
 * Baselines list + compare view. A baseline is a named, immutable set of
 * `(requirementId, version)` pins produced automatically when a review is
 * approved (or manually by a review administrator via the API). Pick two
 * baselines to see added / removed / changed (field-level) / unchanged sets.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { baselinesApi, type BaselineSummary } from "@/lib/baselines-api";
import { queryKeys } from "@/lib/query-keys";
import { BaselineCompareView } from "@/components/baselines/BaselineCompareView";

/** One-line baseline row summary. Exported for unit testing. */
export function summarizeBaseline(baseline: BaselineSummary): string {
  const parts = [
    `${baseline.itemCount} pin${baseline.itemCount === 1 ? "" : "s"}`,
    baseline.reviewRequest
      ? `from review "${baseline.reviewRequest.title}"`
      : `manual, by ${baseline.createdBy.displayName}`,
  ];
  const created = new Date(baseline.createdAt);
  if (!Number.isNaN(created.getTime())) {
    parts.push(`created ${created.toLocaleDateString()}`);
  }
  return parts.join(" · ");
}

export default function ProjectBaselinesPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params?.id ?? "");
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");

  const list = useQuery({
    queryKey: queryKeys.baselines.list(projectId),
    queryFn: () => baselinesApi.list(projectId, 1, 100),
    enabled: projectId !== "",
  });

  const canCompare = compareA !== "" && compareB !== "" && compareA !== compareB;
  const compare = useQuery({
    queryKey: queryKeys.baselines.compare(compareA, compareB),
    queryFn: () => baselinesApi.compare(compareA, compareB),
    enabled: canCompare,
  });

  const baselines = list.data?.baselines ?? [];

  return (
    <div className="space-y-6 p-2 md:p-0">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Baselines</h1>
        <p className="text-sm text-muted-foreground">
          Immutable snapshots of approved requirement versions. A baseline is created automatically
          when a review is approved; compare two baselines to see what changed between sign-offs.
        </p>
      </header>

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading baselines…</p>
      ) : list.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Failed to load baselines. Please try again.
        </p>
      ) : baselines.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          No baselines yet. Approve a review of requirements to create the first one.
        </Card>
      ) : (
        <>
          <ul className="space-y-2" aria-label="Baselines">
            {baselines.map((baseline) => (
              <li key={baseline.id}>
                <Link
                  href={`/projects/${projectId}/baselines/${baseline.id}`}
                  data-testid={`baseline-row-${baseline.id}`}
                  className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Card className="space-y-1 p-4 transition hover:border-primary/60">
                    <span className="text-sm font-semibold">{baseline.name}</span>
                    <p className="text-xs text-muted-foreground">{summarizeBaseline(baseline)}</p>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>

          {baselines.length >= 2 ? (
            <section className="space-y-3" aria-label="Compare baselines">
              <h2 className="text-sm font-semibold">Compare two baselines</h2>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1">
                  <span className="text-muted-foreground">From</span>
                  <select
                    className="rounded border bg-background px-2 py-1"
                    value={compareA}
                    onChange={(e) => setCompareA(e.target.value)}
                    data-testid="compare-select-a"
                  >
                    <option value="">Select baseline…</option>
                    {baselines.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-muted-foreground">to</span>
                  <select
                    className="rounded border bg-background px-2 py-1"
                    value={compareB}
                    onChange={(e) => setCompareB(e.target.value)}
                    data-testid="compare-select-b"
                  >
                    <option value="">Select baseline…</option>
                    {baselines.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {compareA !== "" && compareA === compareB ? (
                <p className="text-xs text-muted-foreground">
                  Pick two different baselines to compare.
                </p>
              ) : compare.isLoading && canCompare ? (
                <p className="text-sm text-muted-foreground">Comparing…</p>
              ) : compare.isError ? (
                <p className="text-sm text-destructive" role="alert">
                  Failed to compare baselines. Please try again.
                </p>
              ) : compare.data ? (
                <BaselineCompareView result={compare.data} />
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
