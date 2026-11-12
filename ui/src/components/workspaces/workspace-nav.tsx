"use client";

/**
 * The header of every `/workspaces/<id>` page (#2339): which workspace this is,
 * a way back to the project the user came from, and the workspace's sections.
 *
 * Moved out of `app/(authed)/workspaces/[id]/layout.tsx` (Epic #47 / #54) so it
 * is measured. #1871 — the Governing documents tab shows only once its list
 * route answers: a 404 means the feature is off, or the caller is no member.
 *
 * The project is the one the top bar last had active (`ProjectSwitcher` stores
 * it whenever a project resolves), read after mount so the server render and
 * the first client render agree.
 */
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2 } from "lucide-react";
import { readStoredActiveProjectId } from "@/lib/active-project";
import { workspaceListQuery } from "@/lib/active-workspace";
import { useGoverningTabVisible } from "@/lib/governing-api";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";

export interface WorkspaceTab {
  href: string;
  label: string;
}

/** The workspace's sections, in nav order; Governing documents only while it is available. */
export function workspaceTabs(workspaceId: string, governingVisible: boolean): WorkspaceTab[] {
  const base = `/workspaces/${workspaceId}`;
  return [
    { href: base, label: "Overview" },
    { href: `${base}/traceability`, label: "Traceability" },
    ...(governingVisible ? [{ href: `${base}/governing`, label: "Governing documents" }] : []),
    // #31 — workspace cost lives on the one Usage page, scoped to this workspace.
    {
      href: `/settings/usage?scope=workspace&workspaceId=${encodeURIComponent(workspaceId)}`,
      label: "Usage & cost",
    },
    { href: `${base}/agents/new`, label: "New Agent" },
  ];
}

const noSubscription = () => () => {};

export function WorkspaceNav({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const pathname = usePathname();
  const governingVisible = useGoverningTabVisible(workspaceId);
  const workspaces = useQuery(workspaceListQuery);
  // A workspace missing from the caller's list has no name to show: say only "Workspace".
  const name = workspaces.data?.find((w) => w.id === workspaceId)?.name ?? null;

  const projectId = useSyncExternalStore(noSubscription, readStoredActiveProjectId, () => null);
  // Shared with the project switcher and Overview: usually already cached.
  const project = useQuery({
    queryKey: queryKeys.projects.detail(projectId ?? ""),
    queryFn: () => projectsApi.get(projectId as string),
    enabled: Boolean(projectId),
  });
  // The stored project may belong to another workspace: lead back only to one in this one.
  const backTo =
    !project.isError && project.data?.workspaceId === workspaceId ? project.data : null;

  return (
    <div className="border-b px-6 pt-3">
      {backTo ? (
        <Link
          href={`/projects/${backTo.id}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to {backTo.name}
        </Link>
      ) : null}
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Building2 className="h-4 w-4" aria-hidden />
        {name ? (
          <>
            <span>Workspace:</span>{" "}
            <span className="font-medium text-foreground" data-testid="workspace-nav-name">
              {name}
            </span>
          </>
        ) : (
          <span data-testid="workspace-nav-name">Workspace</span>
        )}
      </p>
      <nav aria-label="Workspace" className="flex gap-2 py-2">
        {workspaceTabs(workspaceId, governingVisible).map((t) => {
          const current = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={current ? "page" : undefined}
              className={`rounded px-3 py-1 text-sm font-medium ${
                current
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
