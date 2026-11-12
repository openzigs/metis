"use client";

/**
 * Workspace-scoped layout (Epic #47 / Issue #54).
 *
 * Establishes the `/workspaces/:id` surface. #2339 — the header (workspace
 * name, the way back to the project, the section nav) is `WorkspaceNav`.
 */
import { useParams } from "next/navigation";
import { WorkspaceNav } from "@/components/workspaces/workspace-nav";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  if (!id) return <div className="p-6">Invalid workspace id.</div>;

  return (
    <div className="flex flex-col">
      <WorkspaceNav workspaceId={id} />
      {children}
    </div>
  );
}
