"use client";

/**
 * Requirements tab landing (#28, epic #26) — see `RequirementsHub`.
 */
import { useParams } from "next/navigation";
import { RequirementsHub } from "@/components/requirements/requirements-hub";

export default function ProjectRequirementsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-requirements-root">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Requirements</h1>
        <p className="text-sm text-muted-foreground">
          What the analyses produced, and what is still waiting for review.
        </p>
      </header>
      <RequirementsHub projectId={projectId} />
    </div>
  );
}
