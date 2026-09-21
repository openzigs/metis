/**
 * Epic #196 / #224 — Top-level /databases.
 *
 * Read-only cross-project view of every database connector. Mirrors
 * /repositories. No new server endpoints; fans out to the existing
 * `GET /api/projects/:id/connectors/dbs` route per project.
 */
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { DatabaseConnector } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { projectsApi, type Project } from "@/lib/projects-api";
import { dbConnectorsApi } from "@/lib/connectors-api";
import { ApiError } from "@/lib/api-client";

interface AggregatedDb extends DatabaseConnector {
  projectName: string;
}

export default function DatabasesTopLevelPage() {
  const projectsQuery = useQuery({
    queryKey: ["top-level", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    retry: false,
  });
  const projects = projectsQuery.data?.items ?? [];

  const dbQueries = useQueries({
    queries: projects.map((p: Project) => ({
      queryKey: ["top-level", "dbs", p.id],
      queryFn: () => dbConnectorsApi.list(p.id),
      retry: false,
      enabled: projectsQuery.isSuccess,
    })),
  });

  const [filter, setFilter] = useState<string>("");

  const aggregated: AggregatedDb[] = useMemo(() => {
    const rows: AggregatedDb[] = [];
    dbQueries.forEach((q, idx) => {
      const project = projects[idx];
      if (!project || !q.data) return;
      for (const item of q.data) {
        rows.push({ ...item, projectName: project.name });
      }
    });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [dbQueries, projects]);

  const filtered = useMemo(
    () => (filter ? aggregated.filter((r) => r.projectId === filter) : aggregated),
    [aggregated, filter],
  );

  const isLoading =
    projectsQuery.isLoading || dbQueries.some((q) => q.isLoading || q.fetchStatus === "fetching");

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="databases-top-root">
      <header>
        <h1 className="text-2xl font-semibold">Databases</h1>
        <p className="text-sm text-muted-foreground">
          Read-only catalogue of every database connection across projects. To create or edit, open
          the project and use its <strong>Connections</strong> tab.
        </p>
      </header>
      <Card className="space-y-3 p-4" data-testid="databases-top-controls">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Filter by project</span>
            <select
              data-testid="databases-top-project-filter"
              aria-label="Filter databases by project"
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
            {filtered.length} database connection{filtered.length === 1 ? "" : "s"} visible
            {filter ? " (filtered)" : ""}.
          </p>
        </div>
      </Card>
      <Card className="p-4" data-testid="databases-top-list-card">
        {projectsQuery.isError ? (
          <p
            role="alert"
            className="rounded border border-destructive p-2 text-xs text-destructive"
          >
            {(projectsQuery.error as ApiError).message}
          </p>
        ) : isLoading ? (
          <p className="text-xs text-muted-foreground">Loading databases…</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="databases-top-empty">
            No database connections visible.
          </p>
        ) : (
          <table
            className="w-full text-left text-xs"
            aria-label="Database connections across projects"
            data-testid="databases-top-table"
          >
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Label</th>
                <th className="py-1 pr-3 font-medium">Project</th>
                <th className="py-1 pr-3 font-medium">Driver</th>
                <th className="py-1 pr-3 font-medium">Host</th>
                <th className="py-1 pr-3 font-medium">Database</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Open</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-t" data-testid={`databases-top-row-${row.id}`}>
                  <td className="py-1 pr-3 font-mono">{row.label}</td>
                  <td className="py-1 pr-3">{row.projectName}</td>
                  <td className="py-1 pr-3">{row.driver}</td>
                  <td className="py-1 pr-3">{row.host ?? "—"}</td>
                  <td className="py-1 pr-3">{row.databaseName ?? "—"}</td>
                  <td className="py-1 pr-3">{row.status}</td>
                  <td className="py-1 pr-3">
                    <Link
                      href={`/projects/${row.projectId}/connections`}
                      className="underline"
                      data-testid={`databases-top-open-${row.id}`}
                    >
                      In project →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
