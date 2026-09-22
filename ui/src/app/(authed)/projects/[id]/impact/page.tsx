"use client";

/**
 * Project-scoped Impact Analysis (#28, epic #26) — the Analyze tab's entry to
 * impact analysis, which is otherwise a cross-project tool in the sidebar.
 * #61 — lists this project's own runs (`GET /impact-analyses?projectId=`).
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ImpactAnalysesTable } from "@/components/impact/impact-analyses-table";
import { useImpactAnalyses } from "@/lib/impact-analysis-hooks";

export default function ProjectImpactPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const { data, isLoading, isError } = useImpactAnalyses(projectId);
  // The server already narrows by `projectId`; checking `projectIds` too keeps
  // another project's run off this page if that filter is ever lost.
  const analyses = (data ?? []).filter((a) => a.projectIds.includes(projectId));
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-impact-root">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Impact Analysis</h1>
        <p className="text-sm text-muted-foreground">
          Trace a requirement change to the code and database objects it affects in this project.
        </p>
      </header>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm">
          Start from pasted text or one of this project&apos;s documents. The project is
          pre-selected; add others to compare impact across projects.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link
              href={`/impact-analyses/new?projectId=${encodeURIComponent(projectId)}`}
              data-testid="project-impact-new"
            >
              New impact analysis
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/impact-analyses" data-testid="project-impact-all">
              All impact analyses
            </Link>
          </Button>
        </div>
      </Card>
      <section aria-labelledby="project-impact-runs" className="space-y-2">
        <h2 id="project-impact-runs" className="text-lg font-semibold">
          This project&apos;s impact analyses
        </h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground" data-testid="impact-list-loading">
            Loading analyses…
          </p>
        ) : isError ? (
          <Card
            className="border-destructive p-4 text-sm text-destructive"
            data-testid="impact-list-error"
          >
            Could not load impact analyses.
          </Card>
        ) : analyses.length === 0 ? (
          <Card
            className="p-6 text-center text-sm text-muted-foreground"
            data-testid="impact-list-empty"
          >
            No impact analysis includes this project yet.
          </Card>
        ) : (
          <ImpactAnalysesTable analyses={analyses} />
        )}
      </section>
    </div>
  );
}
