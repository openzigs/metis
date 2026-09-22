"use client";

/**
 * #28 (epic #26) — Library is the one home for skills, so it carries its own
 * way into a project's skill allowlist. The project tabs used to link here with
 * `?projectId=` from the Docs menu; that entry is gone, and this picker sets
 * the same parameter. Shown only to users holding `project.update`, the
 * server's gate on saving the allowlist (#469).
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { projectsApi } from "@/lib/projects-api";
import { Label } from "@/components/ui/label";

export function LibraryProjectPicker({ projectId }: { projectId: string | null }) {
  const router = useRouter();
  const { user } = useAuth();
  const canManage = user?.permissions.includes("project.update") ?? false;
  const projects = useQuery({
    queryKey: ["library", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    enabled: canManage,
  });

  if (!canManage) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor="library-project">Manage skills and agents for</Label>
      <select
        id="library-project"
        data-testid="library-project-picker"
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={projectId ?? ""}
        disabled={projects.isLoading}
        onChange={(e) => {
          const next = e.target.value;
          router.replace(next ? `/library?projectId=${encodeURIComponent(next)}` : "/library");
        }}
      >
        <option value="">No project (browse only)</option>
        {(projects.data?.items ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
