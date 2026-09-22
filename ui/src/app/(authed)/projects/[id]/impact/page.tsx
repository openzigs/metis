"use client";

/**
 * Project-scoped Impact Analysis (#28, epic #26) — the Analyze tab's entry to
 * impact analysis, which is otherwise a cross-project tool in the sidebar.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function ProjectImpactPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
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
    </div>
  );
}
