/**
 * Epic #196 / #224 — Top-level /repositories.
 *
 * Read-only cross-project view of every repo connector the caller can see.
 * No new server endpoints — the page lists projects via `/api/projects`
 * and fans out to `GET /api/projects/:id/connectors/repos`. RBAC is
 * inherited automatically (projects you can&apos;t read are absent).
 */
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { RepoConnector } from "@metis/shared";
import { Card } from "@/components/ui/card";
import {
  ResponsiveTable,
  touchTargetClass,
  type ResponsiveColumn,
} from "@/components/tables/responsive-table";
import { projectsApi, type Project } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { ApiError } from "@/lib/api-client";

interface AggregatedRepo extends RepoConnector {
  projectName: string;
}

const repositoryColumns: ResponsiveColumn<AggregatedRepo>[] = [
  { key: "label", header: "Label", cell: (row) => row.label, cellClassName: "font-mono" },
  { key: "project", header: "Project", cell: (row) => row.projectName },
  { key: "provider", header: "Provider", cell: (row) => row.provider },
  {
    key: "ownerRepo",
    header: "Owner / Repo",
    cell: (row) => `${row.ownerOrOrg}/${row.repoName}`,
  },
  { key: "status", header: "Status", cell: (row) => row.status },
  {
    key: "open",
    header: "Open",
    cell: (row) => (
      <Link
        href={`/projects/${row.projectId}/connections`}
        className={`${touchTargetClass} underline`}
        data-testid={`repositories-top-open-${row.id}`}
      >
        In project →
      </Link>
    ),
  },
  {
    key: "scan",
    header: "Scan",
    cell: (row) => (
      <Link
        href={`/projects/${row.projectId}/repositories/${row.id}/scanner`}
        className={`${touchTargetClass} underline`}
        data-testid={`repositories-top-scan-${row.id}`}
      >
        Scan for bugs →
      </Link>
    ),
  },
];

export default function RepositoriesTopLevelPage() {
  const projectsQuery = useQuery({
    queryKey: ["top-level", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    retry: false,
  });
  const projects = projectsQuery.data?.items ?? [];

  const repoQueries = useQueries({
    queries: projects.map((p: Project) => ({
      queryKey: ["top-level", "repos", p.id],
      queryFn: () => repoConnectorsApi.list(p.id),
      retry: false,
      enabled: projectsQuery.isSuccess,
    })),
  });

  const [filter, setFilter] = useState<string>("");

  const aggregated: AggregatedRepo[] = useMemo(() => {
    const rows: AggregatedRepo[] = [];
    repoQueries.forEach((q, idx) => {
      const project = projects[idx];
      if (!project || !q.data) return;
      for (const item of q.data) {
        rows.push({ ...item, projectName: project.name });
      }
    });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [repoQueries, projects]);

  const filtered = useMemo(
    () => (filter ? aggregated.filter((r) => r.projectId === filter) : aggregated),
    [aggregated, filter],
  );

  const isLoading =
    projectsQuery.isLoading || repoQueries.some((q) => q.isLoading || q.fetchStatus === "fetching");

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="repositories-top-root">
      <header>
        <h1 className="text-2xl font-semibold">Repositories</h1>
        <p className="text-sm text-muted-foreground">
          Read-only catalogue of every Git repository connection across projects. To create or edit,
          open the project and use its
          <strong> Connections</strong> tab.
        </p>
      </header>
      <Card className="space-y-3 p-4" data-testid="repositories-top-controls">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Filter by project</span>
            <select
              data-testid="repositories-top-project-filter"
              aria-label="Filter repositories by project"
              className="rounded border bg-background px-2 py-1 text-sm"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((p: Project) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            {filtered.length} repository connection{filtered.length === 1 ? "" : "s"} visible
            {filter ? " (filtered)" : ""}.
          </p>
        </div>
      </Card>
      <Card className="p-4" data-testid="repositories-top-list-card">
        {projectsQuery.isError ? (
          <p
            role="alert"
            className="rounded border border-destructive p-2 text-xs text-destructive"
          >
            {(projectsQuery.error as ApiError).message}
          </p>
        ) : isLoading ? (
          <p className="text-xs text-muted-foreground">Loading repositories…</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="repositories-top-empty">
            No repository connections visible.
          </p>
        ) : (
          <ResponsiveTable
            data={filtered}
            getRowKey={(row) => row.id}
            ariaLabel="Repository connections across projects"
            data-testid="repositories-top-table"
            rowTestId={(row) => `repositories-top-row-${row.id}`}
            columns={repositoryColumns}
          />
        )}
      </Card>
    </div>
  );
}
