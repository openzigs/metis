"use client";

/**
 * Requirements tab (#28, epic #26). #2347 — the tab is the list of the
 * project's requirements across change requests (`RequirementsList`), with the
 * approval ladder stated once; the per-change-request summary (`RequirementsHub`)
 * follows it.
 */
import { useParams } from "next/navigation";
import { RequirementsHub } from "@/components/requirements/requirements-hub";
import { RequirementsList } from "@/components/requirements/requirements-list";
import { PageHeader } from "@/components/ui/page-header";

export default function ProjectRequirementsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-requirements-root">
      <PageHeader
        title="Requirements"
        description="Every requirement across this project's change requests: approve, edit or send them for review."
      />
      <RequirementsList projectId={projectId} />
      <RequirementsHub projectId={projectId} />
    </div>
  );
}
