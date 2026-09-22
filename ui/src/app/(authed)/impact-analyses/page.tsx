/**
 * Epic #159 (#166) — Impact analyses list.
 *
 * Lists every impact analysis the caller can see and links into each report.
 */
"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ImpactAnalysesTable } from "@/components/impact/impact-analyses-table";
import { useImpactAnalyses } from "@/lib/impact-analysis-hooks";

export default function ImpactAnalysesPage() {
  const { data, isLoading, isError } = useImpactAnalyses();
  const analyses = data ?? [];

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="impact-list-root">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Impact analysis</h1>
          <p className="text-sm text-muted-foreground">
            Trace requirement changes to affected code across multiple projects. (To synthesize
            requirements for a single project, use that project&apos;s Requirements Analysis tab.)
          </p>
        </div>
        <Button asChild data-testid="impact-list-new">
          <Link href="/impact-analyses/new">New analysis</Link>
        </Button>
      </header>

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
          No impact analyses yet. Start one to map a requirement change to code.
        </Card>
      ) : (
        <ImpactAnalysesTable analyses={analyses} />
      )}
    </div>
  );
}
