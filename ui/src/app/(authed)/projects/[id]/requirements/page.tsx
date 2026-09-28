"use client";

/**
 * Requirements tab landing (#28, epic #26) — see `RequirementsHub`.
 */
import { useParams } from "next/navigation";
import { RequirementsHub } from "@/components/requirements/requirements-hub";
import { PageHeader } from "@/components/ui/page-header";

export default function ProjectRequirementsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-requirements-root">
      <PageHeader
        title="Requirements"
        description="What the analyses produced, and what is still waiting for review."
      />
      <RequirementsHub projectId={projectId} />
    </div>
  );
}
