"use client";

/**
 * Workspace landing page (#2339): what the workspace switcher's "Open
 * workspace" opens. Thin wrapper; the logic lives in
 * `components/workspaces/workspace-overview` (measured), so this page is
 * excluded from coverage like the sibling workspace pages.
 */
import { useParams } from "next/navigation";
import { WorkspaceOverview } from "@/components/workspaces/workspace-overview";

export default function WorkspacePage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id ?? "";

  if (!workspaceId) return <div className="p-6">Invalid workspace id.</div>;

  return <WorkspaceOverview workspaceId={workspaceId} />;
}
