/**
 * Epic #196 / #223 — Top-level /documents.
 *
 * Cross-project view of every document the caller has access to. Per the
 * epic AC, no new server endpoints — the page fans out to the existing
 * per-project route `GET /api/projects/:id/documents` and aggregates
 * client-side. Projects the caller can't read are simply absent from the
 * `/api/projects` listing, so RBAC fall-through is automatic.
 */
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import {
  ResponsiveTable,
  touchTargetClass,
  type ResponsiveColumn,
} from "@/components/tables/responsive-table";
import { documentsApi, projectsApi, type DocumentRow, type Project } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";

interface AggregatedRow extends DocumentRow {
  projectId: string;
  projectName: string;
}

export default function DocumentsTopLevelPage() {
  const qc = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ["top-level", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    retry: false,
  });

  const projects = projectsQuery.data?.items ?? [];

  const docQueries = useQueries({
    queries: projects.map((p: Project) => ({
      queryKey: ["top-level", "documents", p.id],
      queryFn: () => documentsApi.list(p.id, { limit: 100 }),
      retry: false,
      enabled: projectsQuery.isSuccess,
    })),
  });

  const [filter, setFilter] = useState<string>("");

  const aggregated: AggregatedRow[] = useMemo(() => {
    const rows: AggregatedRow[] = [];
    docQueries.forEach((q, idx) => {
      const project = projects[idx];
      if (!project || !q.data) return;
      for (const item of q.data.items) {
        rows.push({ ...item, projectId: project.id, projectName: project.name });
      }
    });
    rows.sort((a, b) => (a.uploadedAt > b.uploadedAt ? -1 : 1));
    return rows;
  }, [docQueries, projects]);

  const filtered = useMemo(() => {
    if (!filter) return aggregated;
    return aggregated.filter((r) => r.projectId === filter);
  }, [aggregated, filter]);

  const isLoading =
    projectsQuery.isLoading || docQueries.some((q) => q.isLoading || q.fetchStatus === "fetching");

  const columns: ResponsiveColumn<AggregatedRow>[] = useMemo(
    () => [
      {
        key: "filename",
        header: "Filename",
        cell: (row) => row.filename,
        cellClassName: "font-mono",
      },
      { key: "project", header: "Project", cell: (row) => row.projectName },
      { key: "status", header: "Status", cell: (row) => row.status },
      {
        key: "spec",
        header: "Spec",
        cell: (row) => (
          <SpecToggle
            projectId={row.projectId}
            documentId={row.id}
            isSpec={row.isSpec ?? false}
            onToggled={() =>
              qc.invalidateQueries({
                queryKey: ["top-level", "documents", row.projectId],
              })
            }
          />
        ),
      },
      {
        key: "uploaded",
        header: "Uploaded",
        cell: (row) => new Date(row.uploadedAt).toLocaleString(),
      },
      {
        key: "open",
        header: "Open",
        cell: (row) => (
          <Link
            href={`/projects/${row.projectId}/documents`}
            className={`${touchTargetClass} underline`}
            data-testid={`documents-top-open-${row.id}`}
          >
            In project →
          </Link>
        ),
      },
    ],
    [qc],
  );

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="documents-top-root">
      <header>
        <h1 className="text-2xl font-semibold">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Every document you can access, across every project. Use the filter to scope to a single
          project. Upload happens inside the destination project so the file lands in the right RAG
          namespace.
        </p>
      </header>
      <Card className="space-y-3 p-4" data-testid="documents-top-controls">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Filter by project</span>
            <select
              data-testid="documents-top-project-filter"
              aria-label="Filter documents by project"
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
            {filtered.length} document{filtered.length === 1 ? "" : "s"} visible
            {filter ? " (filtered)" : ""}.
          </p>
        </div>
      </Card>
      <Card className="p-4" data-testid="documents-top-list-card">
        {projectsQuery.isError ? (
          <p
            role="alert"
            className="rounded border border-destructive p-2 text-xs text-destructive"
          >
            {(projectsQuery.error as ApiError).message}
          </p>
        ) : isLoading ? (
          <p className="text-xs text-muted-foreground">Loading documents…</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="documents-top-empty">
            No documents to display. Upload one from a project&apos;s Documents tab.
          </p>
        ) : (
          <ResponsiveTable
            data={filtered}
            getRowKey={(row) => row.id}
            ariaLabel="Documents across projects"
            data-testid="documents-top-table"
            rowTestId={(row) => `documents-top-row-${row.id}`}
            columns={columns}
          />
        )}
      </Card>
      <UploadHint />
    </div>
  );
}

function UploadHint() {
  return (
    <Card className="p-4" data-testid="documents-top-upload-hint">
      <h2 className="text-sm font-semibold">Upload a document</h2>
      <p className="text-xs text-muted-foreground">
        Documents are uploaded into a specific project so RAG embeddings, access controls, and audit
        log entries inherit that project&apos;s scope. Open a project from{" "}
        <Link href="/projects" className="underline">
          /projects
        </Link>{" "}
        and use the <strong>Documents</strong> tab.
      </p>
    </Card>
  );
}

/** Epic #724 — clickable badge to tag a document as "spec" for spec-checking scans. */
function SpecToggle({
  projectId,
  documentId,
  isSpec,
  onToggled,
}: {
  projectId: string;
  documentId: string;
  isSpec: boolean;
  onToggled: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () => documentsApi.toggleSpec(projectId, documentId, !isSpec),
    onSuccess: () => onToggled(),
  });
  return (
    <button
      type="button"
      title={isSpec ? "Remove spec tag" : "Tag as spec (used by spec scan mode)"}
      className={`${touchTargetClass} justify-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
        isSpec
          ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
          : "bg-muted text-muted-foreground hover:bg-muted/80"
      }`}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      data-testid={`documents-spec-toggle-${documentId}`}
    >
      {isSpec ? "Spec ✓" : "—"}
    </button>
  );
}
