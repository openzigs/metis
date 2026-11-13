/**
 * Epic #159 (#164) — Create a multi-project impact analysis.
 *
 * Pick a requirements-change source (pasted text or an existing document) plus
 * one or more projects (a single project runs a single-project impact; two+
 * enables cross-project comparison), then trigger a per-project code-impact report.
 *
 * #2345 — `?analysisId=` arrives from a change request: its requirements are
 * the source (read by the server), its project stays selected, and the page
 * links back to it.
 */
"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQueries, useQuery } from "@tanstack/react-query";
import { IMPACT_MAX_PROJECTS, type CreateImpactAnalysisInput } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { projectsApi, documentsApi, type Project } from "@/lib/projects-api";
import { useCreateImpactAnalysis } from "@/lib/impact-analysis-hooks";
import { ScopePicker, type ScopeKind } from "@/components/scope/scope-picker";
import { useValidatedActiveWorkspaceId, workspaceListQuery } from "@/lib/active-workspace";
import {
  DocumentSourceSelector,
  type SourceDocument,
  type SourceMode,
} from "@/components/impact/document-source-selector";
import { RunImpactAnalysisButton } from "@/components/impact/run-impact-analysis-button";
import { ApiError } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { analysisApi } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { checkedRequirements } from "@/components/analysis/change-request-checks";

/** #2345 — the change request's own page. */
function changeRequestHref(projectId: string, analysisId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/analysis?${new URLSearchParams({ analysisId }).toString()}`;
}

export default function NewImpactAnalysisPage() {
  const router = useRouter();
  const createMutation = useCreateImpactAnalysis();

  // #28 — the project's Change requests → Impact Analysis entry arrives with
  // `?projectId=` so that project starts selected. The server still checks
  // access to every selected project on submit.
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<string[]>(() => {
    const preselected = searchParams?.get("projectId");
    return preselected ? [preselected] : [];
  });
  // #2351 — which of the shared picker's options the selection is: arriving
  // with a project (or a change request) starts on "This project"; otherwise
  // nothing is chosen, as before.
  const [scopeKind, setScopeKind] = useState<ScopeKind | null>(() =>
    searchParams?.get("projectId") ? "this" : null,
  );
  // #2345 — arriving from a change request (`?analysisId=`), its requirements are
  // the source: the server reads them itself, so nothing is typed again. The
  // snapshot read here only names it and counts them.
  const [changeRequestId, setChangeRequestId] = useState<string | null>(
    () => searchParams?.get("analysisId") ?? null,
  );
  const changeRequest = useQuery({
    queryKey: queryKeys.analyses.detail(changeRequestId ?? ""),
    queryFn: () => analysisApi.get(changeRequestId as string),
    enabled: changeRequestId !== null,
    retry: false,
  });
  const crProjectId = changeRequest.data?.projectId ?? null;
  const crRequirements = changeRequest.data ? checkedRequirements(changeRequest.data).count : 0;
  const [mode, setMode] = useState<SourceMode>("text");
  const [text, setText] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeDependencies, setIncludeDependencies] = useState(false);
  // #2280 — a saved reading of the document is reused unless this is ticked.
  const [rereadDocument, setRereadDocument] = useState(false);

  const projectsQuery = useQuery({
    queryKey: ["impact", "projects"],
    queryFn: () => projectsApi.list({ limit: 100 }),
    retry: false,
  });
  const projects: Project[] = projectsQuery.data?.items ?? [];
  // #2351 — "This project": the change request's, else the one arrived with.
  const currentProjectId = changeRequestId
    ? (crProjectId ?? searchParams?.get("projectId") ?? null)
    : (searchParams?.get("projectId") ?? null);
  const currentProject = (() => {
    const p = projects.find((x) => x.id === currentProjectId);
    return p ? { id: p.id, name: p.name } : null;
  })();
  // #2351 — "Whole workspace": the top bar's workspace, and its projects the
  // analyst can read (the server filters `/projects` by both), counted by the
  // server rather than from the first page of every project. A workspace with
  // more than one run takes is refused and said, as the portfolio check does,
  // never cut to its first projects.
  const { workspaceId: activeWorkspaceId } = useValidatedActiveWorkspaceId();
  const { data: workspaces = [] } = useQuery(workspaceListQuery);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const workspaceProjects = useQuery({
    queryKey: ["impact", "workspace-projects", activeWorkspace?.id ?? null],
    queryFn: () => projectsApi.list({ workspaceId: activeWorkspace!.id, limit: 100 }),
    enabled: activeWorkspace !== null,
    retry: false,
  });
  const workspaceTotal = workspaceProjects.data?.total ?? null;
  const workspaceTooBig = workspaceTotal !== null && workspaceTotal > IMPACT_MAX_PROJECTS;
  const workspaceProjectIds = (workspaceProjects.data?.items ?? []).map((p) => p.id);
  // Disabled, with the reason, until the workspace's projects are read.
  const workspaceScope =
    activeWorkspace && workspaceProjects.isSuccess
      ? { id: activeWorkspace.id, name: activeWorkspace.name, count: workspaceTotal }
      : null;
  const workspaceNote = !activeWorkspace
    ? "No workspace is open in the top bar."
    : workspaceProjects.isError
      ? "Could not read the workspace's projects."
      : "Loading the workspace's projects…";

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

  const hasSource = changeRequestId
    ? crRequirements > 0
    : mode === "text"
      ? text.trim().length > 0
      : Boolean(documentId);
  // #2345 — the change request's own project stays in the run (the server requires it).
  const keepsChangeRequestProject =
    !changeRequestId || (crProjectId !== null && selected.includes(crProjectId));
  const isValid = selected.length >= 1 && hasSource && keepsChangeRequestProject;

  function handleSubmit() {
    if (!isValid) return;
    const base = changeRequestId
      ? { analysisId: changeRequestId, projectIds: selected }
      : mode === "text"
        ? { text: text.trim(), projectIds: selected }
        : { documentId: documentId as string, projectIds: selected };
    // Keep the payload minimal: only add a flag when it diverges from the
    // schema default (includeSchemaImpact defaults true; includeDependencies
    // defaults false), so the common case stays a bare { text/doc, projectIds }.
    const payload: CreateImpactAnalysisInput = {
      ...base,
      ...(includeSchema ? {} : { includeSchemaImpact: false }),
      ...(includeDependencies ? { includeDependencies: true } : {}),
      ...(!changeRequestId && mode === "document" && rereadDocument
        ? { rereadDocument: true }
        : {}),
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
      <PageHeader
        eyebrow={
          changeRequestId && crProjectId ? (
            <Link
              href={changeRequestHref(crProjectId, changeRequestId)}
              className="text-xs text-muted-foreground hover:underline"
              data-testid="impact-new-back"
            >
              ← Back to the change request
            </Link>
          ) : (
            <Link
              href="/impact-analyses"
              className="text-xs text-muted-foreground hover:underline"
              data-testid="impact-new-back"
            >
              ← Back to impact analyses
            </Link>
          )
        }
        title="New impact analysis"
        description={
          <>
            Map a requirements change to the affected code across multiple projects. (To synthesize
            requirements for a single project, use that project&apos;s Requirements Analysis tab.)
          </>
        }
      />

      {changeRequestId ? (
        <Card className="space-y-1 p-4" data-testid="impact-new-change-request">
          <p className="text-sm font-medium">Change request</p>
          {changeRequest.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading the change request…</p>
          ) : changeRequest.isError || !changeRequest.data ? (
            <p className="text-sm text-destructive">Could not read this change request.</p>
          ) : (
            <>
              <p className="text-sm">{changeRequest.data.title?.trim() || "Change request"}</p>
              <p className="text-xs text-muted-foreground">
                {crRequirements === 0
                  ? "It has no draft or approved requirements to analyse yet."
                  : `Its ${crRequirements} draft and approved requirement${crRequirements === 1 ? " is" : "s are"} analysed; METIS reads them itself. Keep its project selected.`}
              </p>
            </>
          )}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            onClick={() => setChangeRequestId(null)}
          >
            Use pasted text or a document instead
          </Button>
        </Card>
      ) : (
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
      )}

      {/* #2351 — the shared scope picker (chat and the portfolio check use the same). */}
      <div className="space-y-1" data-testid="impact-new-scope">
        <p className="text-sm font-medium">Where to look</p>
        <ScopePicker
          kind={scopeKind}
          chosenIds={selected}
          items={projects.map((p) => ({ id: p.id, name: p.name }))}
          itemsLoading={projectsQuery.isLoading}
          current={currentProject}
          currentNote="Open this from a project or a change request to start there."
          workspace={workspaceScope}
          workspaceNote={workspaceNote}
          onPickThis={() => {
            if (!currentProject) return;
            setScopeKind("this");
            setSelected([currentProject.id]);
          }}
          onPickWorkspace={() => {
            if (!workspaceScope) return;
            setScopeKind("workspace");
            setSelected(workspaceTooBig ? [] : workspaceProjectIds);
          }}
          onToggle={(p) => {
            const base = scopeKind === "chosen" ? selected : [];
            setScopeKind("chosen");
            setSelected(base.includes(p.id) ? base.filter((id) => id !== p.id) : [...base, p.id]);
          }}
          maxChosen={IMPACT_MAX_PROJECTS}
          testIdBase="impact-scope"
          ariaLabel="Projects to analyse"
        />
        <p className="text-xs text-muted-foreground" data-testid="multi-project-count">
          {scopeKind === "workspace" && workspaceTooBig
            ? `The workspace has more than ${IMPACT_MAX_PROJECTS} projects: choose up to ${IMPACT_MAX_PROJECTS}.`
            : `${selected.length} selected`}
        </p>
      </div>

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

      {mode === "document" && !changeRequestId ? (
        <label className="flex items-center gap-2 text-sm" data-testid="impact-new-reread-toggle">
          <input
            type="checkbox"
            checked={rereadDocument}
            onChange={(e) => setRereadDocument(e.target.checked)}
            data-testid="impact-new-reread-checkbox"
          />
          Read the document again (otherwise a saved reading of the same file is reused, at no cost)
        </label>
      ) : null}

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
            {changeRequestId && !keepsChangeRequestProject && crProjectId
              ? "Keep the change request's project selected."
              : "Select at least one project and provide a change source."}
          </span>
        ) : null}
      </div>
    </div>
  );
}
