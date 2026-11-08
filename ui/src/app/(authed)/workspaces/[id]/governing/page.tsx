"use client";

/**
 * Workspace governing documents page (Epic #1866 / Issue #1871).
 *
 * Thin data-wiring wrapper: reads the workspace id from the route and renders
 * the panel. The testable logic lives in
 * `components/governing/governing-documents-panel` (measured); this page is
 * excluded from coverage like the sibling workspace pages.
 */
import { useParams } from "next/navigation";
import { GoverningDocumentsPanel } from "@/components/governing/governing-documents-panel";
import { PageHeader } from "@/components/ui/page-header";

export default function WorkspaceGoverningPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id ?? "";

  if (!workspaceId) return <div className="p-6">Invalid workspace id.</div>;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Governing documents"
        description="The policies and control frameworks this workspace follows, and the rules extracted from them."
      />
      <GoverningDocumentsPanel workspaceId={workspaceId} />
    </div>
  );
}
