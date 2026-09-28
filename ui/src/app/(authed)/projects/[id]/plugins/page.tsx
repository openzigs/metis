"use client";

/**
 * Epic #165 / Issue #123 — Plugins import/export page.
 *
 * Thin route wrapper around <PluginsManager> for the active project.
 */
import { useParams } from "next/navigation";
import { PluginsManager } from "@/components/projects/plugins-manager";
import { PageHeader } from "@/components/ui/page-header";

export default function ProjectPluginsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  if (!id) return <div className="p-6">Invalid project id.</div>;

  return (
    <div className="space-y-6 p-6" data-testid="plugins-page">
      <PageHeader
        title="Plugins"
        description="Export skills, agents, and hooks as a portable plugin, or import an existing plugin envelope into this project."
      />
      <PluginsManager projectId={id} />
    </div>
  );
}
