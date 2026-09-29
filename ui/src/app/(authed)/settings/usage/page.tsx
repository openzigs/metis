"use client";

/**
 * #31 — the one home for usage and cost. Scope is a tab on this page rather
 * than a separate page per scope:
 *
 *   • Project      — one project's tokens, cost and budget (was /projects/:id/usage)
 *   • Workspace    — a workspace's spend forecast, budget and alerts (was /workspaces/:id/finops)
 *   • All projects — platform-wide usage, admins only (was /admin/usage)
 *
 * The scope and its subject live in the query string (`?scope=&projectId=&workspaceId=`)
 * so every retired URL redirects to the same view it used to show.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { projectsApi } from "@/lib/projects-api";
import { PageHeader } from "@/components/ui/page-header";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectUsagePanel } from "@/components/usage/project-usage-panel";
import { PlatformUsagePanel } from "@/components/usage/platform-usage-panel";
import { WorkspaceFinopsPanel } from "@/components/finops/workspace-finops-panel";

type UsageScope = "project" | "workspace" | "platform";

const SCOPES: ReadonlyArray<{ id: UsageScope; label: string; adminOnly?: boolean }> = [
  { id: "project", label: "Project" },
  { id: "workspace", label: "Workspace" },
  { id: "platform", label: "All projects", adminOnly: true },
];

/** Same key the header workspace switcher writes. */
const ACTIVE_WORKSPACE_KEY = "metis.activeWorkspaceId";

interface WorkspaceOption {
  id: string;
  name: string;
}

function storedWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

const SELECT_CLASS = "h-9 rounded-md border border-input bg-background px-2 text-sm";

export default function SettingsUsagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const scopes = SCOPES.filter((s) => isAdmin || !s.adminOnly);
  const requested = searchParams?.get("scope");
  const scope: UsageScope = scopes.find((s) => s.id === requested)?.id ?? "project";
  const projectId = searchParams?.get("projectId") ?? "";
  const workspaceParam = searchParams?.get("workspaceId") ?? "";

  const setParams = (next: Record<string, string>) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.replace(`/settings/usage?${params.toString()}`);
  };

  const projects = useQuery({
    queryKey: ["settings-usage", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    enabled: scope === "project",
  });
  const workspaces = useQuery({
    queryKey: ["settings-usage", "workspaces"],
    queryFn: () => apiFetch<WorkspaceOption[]>("/workspaces"),
    enabled: scope === "workspace",
  });

  const workspaceList = workspaces.data ?? [];
  const stored = scope === "workspace" ? storedWorkspaceId() : null;
  const workspaceId =
    workspaceParam ||
    (stored && workspaceList.some((w) => w.id === stored) ? stored : (workspaceList[0]?.id ?? ""));

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-usage-root">
      <PageHeader
        title="Usage & cost"
        description="Tokens, spend and budgets. Pick a scope to see one project, a workspace, or every project."
      />
      <Tabs value={scope} onValueChange={(v) => setParams({ scope: v })}>
        <TabsList aria-label="Usage scope">
          {scopes.map((s) => (
            <TabsTrigger key={s.id} value={s.id} data-testid={`usage-scope-${s.id}`}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="project" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="usage-project">Project</Label>
            <select
              id="usage-project"
              data-testid="usage-project-picker"
              className={SELECT_CLASS}
              value={projectId}
              disabled={projects.isLoading}
              onChange={(e) => setParams({ projectId: e.target.value })}
            >
              <option value="">Choose a project…</option>
              {/* One page of 100; a project past it is still the selection. */}
              {projectId &&
              projects.data &&
              !projects.data.items.some((p) => p.id === projectId) ? (
                <option value={projectId}>Current project</option>
              ) : null}
              {(projects.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {projectId ? (
            <ProjectUsagePanel projectId={projectId} />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="usage-project-empty">
              Choose a project to see its usage.
            </p>
          )}
        </TabsContent>

        <TabsContent value="workspace" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="usage-workspace">Workspace</Label>
            <select
              id="usage-workspace"
              data-testid="usage-workspace-picker"
              className={SELECT_CLASS}
              value={workspaceId}
              disabled={workspaces.isLoading}
              onChange={(e) => setParams({ workspaceId: e.target.value })}
            >
              {workspaceList.length === 0 ? <option value="">No workspaces</option> : null}
              {workspaceList.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          {workspaceId ? (
            <WorkspaceFinopsPanel workspaceId={workspaceId} />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="usage-workspace-empty">
              {workspaces.isLoading
                ? "Loading workspaces…"
                : "You are not a member of a workspace."}
            </p>
          )}
        </TabsContent>

        {isAdmin ? (
          <TabsContent value="platform">
            <PlatformUsagePanel />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
