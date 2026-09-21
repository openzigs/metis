"use client";

/**
 * Epic #165 / Issue #123 — Plugins import/export page.
 *
 * Thin route wrapper around <PluginsManager> for the active project.
 */
import { useParams } from "next/navigation";
import { PluginsManager } from "@/components/projects/plugins-manager";

export default function ProjectPluginsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  if (!id) return <div className="p-6">Invalid project id.</div>;

  return (
    <div className="space-y-6 p-6" data-testid="plugins-page">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">
          Export skills, agents, and hooks as a portable plugin, or import an existing plugin
          envelope into this project.
        </p>
      </header>
      <PluginsManager projectId={id} />
    </div>
  );
}
