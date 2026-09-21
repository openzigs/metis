"use client";

/**
 * Workspace traceability rollup page (Epic #610 / Issue #626).
 *
 * Thin data-wiring wrapper: reads the workspace id from the route and renders
 * the rollup component (per-project coverage table + cross-project link map).
 * The testable logic lives in `components/traceability/workspace-traceability-rollup`
 * (measured); this page is excluded from coverage like the sibling workspace
 * pages.
 */
import { useParams } from "next/navigation";
import { WorkspaceTraceabilityRollup } from "@/components/traceability/workspace-traceability-rollup";

export default function WorkspaceTraceabilityPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id ?? "";

  if (!workspaceId) return <div className="p-6">Invalid workspace id.</div>;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Traceability</h1>
      <p className="text-sm text-muted-foreground">
        Requirement coverage and cross-project links across this workspace.
      </p>
      <WorkspaceTraceabilityRollup workspaceId={workspaceId} />
    </div>
  );
}
