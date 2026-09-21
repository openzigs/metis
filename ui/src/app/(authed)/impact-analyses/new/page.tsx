/**
 * Epic #159 (#164) — Create a multi-project impact analysis.
 *
 * Pick a requirements-change source (pasted text or an existing document) plus
 * one or more projects (a single project runs a single-project impact; two+
 * enables cross-project comparison), then trigger a per-project code-impact report.
 */
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CreateImpactAnalysisInput } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { projectsApi, documentsApi, type Project } from "@/lib/projects-api";
import { useCreateImpactAnalysis } from "@/lib/impact-analysis-hooks";
import { MultiProjectPicker } from "@/components/impact/multi-project-picker";
import {
  DocumentSourceSelector,
  type SourceDocument,
  type SourceMode,
} from "@/components/impact/document-source-selector";
import { RunImpactAnalysisButton } from "@/components/impact/run-impact-analysis-button";
import { ApiError } from "@/lib/api-client";

export default function NewImpactAnalysisPage() {
  const router = useRouter();
  const createMutation = useCreateImpactAnalysis();

  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<SourceMode>("text");
  const [text, setText] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeDependencies, setIncludeDependencies] = useState(false);

  const projectsQuery = useQuery({
    queryKey: ["impact", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    retry: false,
  });
  const projects: Project[] = projectsQuery.data?.items ?? [];

  // Fan out to the documents of the selected projects only.
  const documentQueries = useQueries({
    queries: selected.map((projectId) => ({
      queryKey: ["impact", "documents", projectId],
      queryFn: () => documentsApi.list(projectId, { limit: 100 }),
      retry: false,
      enabled: mode === "document",
    })),
  });

  const documents: SourceDocument[] = useMemo(() => {
    const rows: SourceDocument[] = [];
    documentQueries.forEach((q, idx) => {
      const projectId = selected[idx];
      const project = projects.find((p) => p.id === projectId);
      for (const doc of q.data?.items ?? []) {
        rows.push({ id: doc.id, filename: doc.filename, projectName: project?.name ?? projectId });
      }
    });
    return rows;
  }, [documentQueries, projects, selected]);

  const documentsLoading = mode === "document" && documentQueries.some((q) => q.isLoading);

  const hasSource = mode === "text" ? text.trim().length > 0 : Boolean(documentId);
  const isValid = selected.length >= 1 && hasSource;

  function handleSubmit() {
    if (!isValid) return;
    const base =
      mode === "text"
        ? { text: text.trim(), projectIds: selected }
        : { documentId: documentId as string, projectIds: selected };
    // Keep the payload minimal: only add a flag when it diverges from the
    // schema default (includeSchemaImpact defaults true; includeDependencies
    // defaults false), so the common case stays a bare { text/doc, projectIds }.
    const payload: CreateImpactAnalysisInput = {
      ...base,
      ...(includeSchema ? {} : { includeSchemaImpact: false }),
      ...(includeDependencies ? { includeDependencies: true } : {}),
    };

    createMutation.mutate(payload, {
      onSuccess: (res) => {
        router.push(`/impact-analyses/${res.id}`);
      },
    });
  }

  const errorMessage =
    createMutation.error instanceof ApiError
      ? createMutation.error.message
      : createMutation.error
        ? "Failed to start impact analysis."
        : null;

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="impact-new-root">
      <header className="space-y-1">
        <Link
          href="/impact-analyses"
          className="text-xs text-muted-foreground hover:underline"
          data-testid="impact-new-back"
        >
          ← Back to impact analyses
        </Link>
        <h1 className="text-2xl font-semibold">New impact analysis</h1>
        <p className="text-sm text-muted-foreground">
          Map a requirements change to the affected code across multiple projects. (To synthesize
          requirements for a single project, use that project&apos;s Requirements Analysis tab.)
        </p>
      </header>

      <DocumentSourceSelector
        mode={mode}
        onModeChange={setMode}
        text={text}
        onTextChange={setText}
        documents={documents}
        documentId={documentId}
        onDocumentChange={setDocumentId}
        documentsLoading={documentsLoading}
      />

      <MultiProjectPicker
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        selected={selected}
        onChange={setSelected}
        isLoading={projectsQuery.isLoading}
      />

      <label className="flex items-center gap-2 text-sm" data-testid="impact-new-schema-toggle">
        <input
          type="checkbox"
          checked={includeSchema}
          onChange={(e) => setIncludeSchema(e.target.checked)}
          data-testid="impact-new-schema-checkbox"
        />
        Include database schema impact (affected tables/columns + suggested DDL)
      </label>

      <label className="flex items-center gap-2 text-sm" data-testid="impact-new-deps-toggle">
        <input
          type="checkbox"
          checked={includeDependencies}
          onChange={(e) => setIncludeDependencies(e.target.checked)}
          data-testid="impact-new-deps-checkbox"
        />
        Include downstream dependencies (what the changed code uses — broader & noisier)
      </label>

      {errorMessage ? (
        <Card
          className="border-destructive p-3 text-sm text-destructive"
          data-testid="impact-new-error"
        >
          {errorMessage}
        </Card>
      ) : null}

      <div className="flex items-center gap-3">
        <RunImpactAnalysisButton
          disabled={!isValid}
          isPending={createMutation.isPending}
          onClick={handleSubmit}
        />
        {!isValid ? (
          <span className="text-xs text-muted-foreground" data-testid="impact-new-hint">
            Select at least one project and provide a change source.
          </span>
        ) : null}
      </div>
    </div>
  );
}
