"use client";

/**
 * Epic #260 / Issue #84 — Custom agent authoring wizard route.
 *
 * Thin app-shell wrapper that resolves the workspace id from the route and
 * delegates to the testable {@link AgentAuthoringWizard} component.
 */
import { useParams } from "next/navigation";
import { AgentAuthoringWizard } from "@/components/custom-agents/AgentAuthoringWizard";

export default function NewAgentWizardPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id ?? "";

  if (!workspaceId) return <div className="p-6">Invalid workspace id.</div>;

  return <AgentAuthoringWizard workspaceId={workspaceId} />;
}
