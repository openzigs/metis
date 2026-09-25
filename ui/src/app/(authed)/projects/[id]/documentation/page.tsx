"use client";

/**
 * Epic #486 / Issue #492 — Documentation tab for projects.
 *
 * Shows generated documentation with:
 * - "Generate Documentation" button with scope selector
 * - List of generated documents
 * - Rich markdown preview with TOC
 * - Export buttons (PDF, Word, Markdown)
 */
import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { useAppMutation } from "@/lib/use-app-mutation";
import {
  useProjectJobEvents,
  useDocSectionProgress,
  useJobLifecycle,
} from "@/hooks/use-job-events";
import { applyJobLifecycleEvent } from "@/hooks/use-active-jobs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PausableLiveRegion } from "@/components/a11y/pausable-live-region";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { MarkdownPreviewer } from "@/components/markdown-previewer";
import { SchemaGraphExplorer } from "@/components/schema-graph-explorer";
import { VersionArtifacts } from "@/components/documentation/version-artifacts";
import type { DocSectionProgressEvent, SchemaGraph } from "@metis/shared";

interface DocWarning {
  kind: string;
  section: string;
  message: string;
  severity: string;
  /**
   * Issue #273 — numeric faithfulness ratio (supported/total) in [0,1] and the
   * threshold it was compared against. Present on entailment-based
   * `section-ungrounded` warnings; surfaced in the banner so users see HOW
   * unfaithful a section is, not just that it is degraded.
   */
  ratio?: number;
  threshold?: number;
  /**
   * Issue #283 — true for inherently-abstractive narrative sections (Overview &
   * Domain, Core Business Capabilities) gated at the lower narrative bar. The
   * banner renders the honest "X% grounded; remainder is domain context" framing
   * for these instead of the alarming "may be unreliable" copy.
   *
   * Retained for back-compat; the banner now switches on the richer `tier`
   * discriminator below, which also distinguishes `reconstruction` from
   * `literal`.
   */
  domainContext?: boolean;
  /**
   * The faithfulness tier this `section-ungrounded` warning was gated at, set by
   * the server's warning builders. `"narrative"` and `"reconstruction"` sections
   * are inferred/domain BY DESIGN (within normal tolerance); `"literal"`
   * code-derived sections below their bar are worth verifying. The banner reads
   * this to choose a severity-appropriate headline and per-section tag WITHOUT
   * re-deriving thresholds. Absent on `section-failed` / `no-modules` and the
   * legacy count-based warning.
   */
  tier?: "narrative" | "reconstruction" | "literal";
}

interface GeneratedDoc {
  id: string;
  title: string;
  scope: string;
  status: string;
  indexing?: {
    state: string;
    status: string;
    chunkCount: number;
    errorMessage?: string | null;
    processedAt?: string | null;
  };
  /**
   * Epic #204 (#225) — genuine error string for `failed` docs. Legacy degraded
   * docs (pre-#252) may still carry a JSON `DocWarning[]` here; the banner reads
   * it only as a fallback.
   */
  errorMessage?: string | null;
  /**
   * #50 — true when a `failed` doc was interrupted by a server restart (set by
   * the detail endpoint), so the view can say so instead of a generic failure.
   */
  interrupted?: boolean;
  /**
   * Epic #204 follow-up (#252) — dedicated structured warnings column. A
   * `DocWarning[]` for `degraded` docs; null/undefined otherwise.
   */
  warnings?: DocWarning[] | null;
  autoUpdate: boolean;
  generatedAt: string | null;
  createdAt: string;
  content?: string;
  /**
   * #190 — version summaries only. A version's body, provenance manifest and
   * changed symbols are fetched from their own endpoints when opened.
   */
  versions?: Array<{
    id: string;
    version: number;
    revisionId?: string;
    diffSummary: string | null;
    createdAt: string;
  }>;
}

export default function DocumentationPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [detailTab, setDetailTab] = useState<"document" | "graph">("document");
  // Read-only "view a previous version" selection. Holds the version id of a
  // non-latest version whose content is being viewed; null = show latest.
  // #190 — its body is fetched on selection, not shipped with the detail.
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // #240 — push-driven cache invalidation: doc-generation lifecycle events in
  // this project refresh the docs list/detail caches so completion appears
  // without a manual refresh (the static "generating" badge problem).
  useProjectJobEvents(projectId);
  // #243 — per-section live progress + warnings for the selected doc.
  const sectionProgress = useDocSectionProgress(selectedDoc);
  // #240 — live lifecycle for the selected doc (drives the generating banner).
  const docJob = useJobLifecycle(selectedDoc);

  // Fetch list of generated docs
  const docsQuery = useQuery<GeneratedDoc[]>({
    queryKey: ["generated-docs", projectId],
    queryFn: () => apiFetch<GeneratedDoc[]>(`/projects/${projectId}/docs`),
    enabled: Boolean(projectId),
  });

  // Fetch single doc detail
  const docDetail = useQuery<GeneratedDoc>({
    queryKey: ["generated-docs", projectId, selectedDoc],
    queryFn: () => apiFetch<GeneratedDoc>(`/projects/${projectId}/docs/${selectedDoc}`),
    enabled: Boolean(selectedDoc),
  });

  // #190 — a previous version's body, fetched only when the user opens it.
  // Versions are immutable, so a fetched body never goes stale.
  const versionBody = useQuery<{ id: string; content: string }>({
    queryKey: ["generated-docs", projectId, selectedDoc, "version", viewingVersionId],
    queryFn: () =>
      apiFetch<{ id: string; content: string }>(
        `/projects/${projectId}/docs/${selectedDoc}/versions/${viewingVersionId}`,
      ),
    enabled: Boolean(selectedDoc) && Boolean(viewingVersionId),
    staleTime: Infinity,
  });

  // Lazily fetch the structured schema graph only when the Schema Graph tab is
  // opened for a database-scope document (Epic #895).
  const isDatabaseDoc = docDetail.data?.scope === "database";
  const schemaGraphQuery = useQuery<SchemaGraph>({
    queryKey: ["schema-graph", projectId, selectedDoc],
    queryFn: () => apiFetch<SchemaGraph>(`/projects/${projectId}/docs/${selectedDoc}/schema-graph`),
    enabled: Boolean(selectedDoc) && isDatabaseDoc && detailTab === "graph",
    staleTime: 5 * 60 * 1000,
  });

  // Generate mutation (#241 — loading + success/error toasts; #242 — invalidate)
  const generateMutation = useAppMutation({
    mutationFn: (params: {
      title: string;
      scope: string;
      docType: string;
      scopeFilter?: Record<string, unknown>;
      groundDomainWithWebResearch?: boolean;
      pathPrefixes?: string[];
    }) =>
      apiFetch<GeneratedDoc>(`/projects/${projectId}/docs/generate`, {
        method: "POST",
        body: params,
      }),
    // #420 — quiet the generic success toast: we fire a richer, action-bearing
    // toast below that links to the live progress, and auto-open the generating
    // doc so the user lands on the rich GenerationProgress instead of a static
    // badge on a closed modal.
    successMessage: false,
    invalidateKeys: [["generated-docs", projectId]],
    onSuccess: (created) => {
      setShowGenerate(false);
      // Auto-navigate to the newly-generating doc's detail view, which already
      // renders the live per-section GenerationProgress. Fall back to a toast
      // link when the server response carries no id.
      if (created?.id) {
        // #420 — seed the global active-jobs indicator immediately so it shows
        // "1 job running" the instant the user triggers a generation, rather than
        // depending on catching the (timing-sensitive) socket `started` event.
        // Live `progress` events refine it and the terminal event (delivered to
        // this job's room, which the auto-nav below joins) clears it.
        applyJobLifecycleEvent({
          kind: "doc-generation",
          jobId: created.id,
          projectId,
          status: "started",
          progress: 0,
          message: "Starting documentation generation…",
          ts: Date.now(),
        });
        setDetailTab("document");
        setViewingVersionId(null);
        setSelectedDoc(created.id);
        toast.success("Generating documentation…", {
          description: "View live progress below.",
          action: {
            label: "View progress",
            onClick: () => {
              setDetailTab("document");
              setViewingVersionId(null);
              setSelectedDoc(created.id);
            },
          },
        });
      } else {
        toast.success("Documentation generation started");
      }
    },
  });

  // Rename mutation
  const renameMutation = useAppMutation({
    mutationFn: (params: { docId: string; title: string }) =>
      apiFetch<GeneratedDoc>(`/projects/${projectId}/docs/${params.docId}`, {
        method: "PATCH",
        body: { title: params.title },
      }),
    successMessage: "Document renamed",
    invalidateKeys: [["generated-docs", projectId]],
    onSuccess: () => {
      setEditingTitle(false);
    },
  });

  const startEditTitle = (currentTitle: string) => {
    setTitleDraft(currentTitle);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (!selectedDoc || !titleDraft.trim()) return;
    renameMutation.mutate({ docId: selectedDoc, title: titleDraft.trim() });
  };

  // #50 — regenerate a failed document in place (e.g. one interrupted by a
  // server restart). The row goes back to `pending` and the live progress takes
  // over from the job events, exactly as for a new generation.
  const regenerateMutation = useAppMutation({
    mutationFn: (docId: string) =>
      apiFetch<{ id: string; status: string }>(`/projects/${projectId}/docs/${docId}/regenerate`, {
        method: "POST",
      }),
    successMessage: "Regenerating documentation…",
    // Prefix match — also refreshes the selected doc's detail query.
    invalidateKeys: [["generated-docs", projectId]],
  });

  // Delete mutation
  const deleteMutation = useAppMutation({
    mutationFn: async (docId: string) => {
      await apiFetch(`/projects/${projectId}/docs/${docId}`, { method: "DELETE" });
    },
    successMessage: "Document deleted",
    invalidateKeys: [["generated-docs", projectId]],
    onSuccess: () => {
      setSelectedDoc(null);
    },
  });

  const handleExport = (docId: string, format: "pdf" | "docx" | "markdown") => {
    const url = `/api/projects/${projectId}/docs/${docId}/export?format=${format}`;
    window.open(url, "_blank");
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Documentation</h1>
        <Button onClick={() => setShowGenerate(true)} data-testid="generate-docs-btn">
          Generate Documentation
        </Button>
      </div>

      {/* Generate modal */}
      {showGenerate && (
        <GenerateForm
          projectId={projectId}
          onSubmit={(
            title,
            scope,
            docType,
            scopeFilter,
            groundDomainWithWebResearch,
            pathPrefixes,
          ) =>
            generateMutation.mutate({
              title,
              scope,
              docType,
              scopeFilter,
              groundDomainWithWebResearch,
              ...(pathPrefixes ? { pathPrefixes } : {}),
            })
          }
          onCancel={() => setShowGenerate(false)}
          isLoading={generateMutation.isPending}
        />
      )}

      {/* Document list */}
      {!selectedDoc && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" data-testid="docs-list">
          {docsQuery.data?.map((doc) => (
            <Card
              key={doc.id}
              className="p-4 cursor-pointer hover:border-primary transition-colors"
              onClick={() => {
                setDetailTab("document");
                setViewingVersionId(null);
                setSelectedDoc(doc.id);
              }}
              data-testid={`doc-card-${doc.id}`}
            >
              <h3 className="font-semibold">{doc.title}</h3>
              <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                <StatusBadge status={doc.status} />
                <IndexingBadge state={doc.indexing?.state} />
                <span className="capitalize">{doc.scope}</span>
                {doc.autoUpdate && (
                  <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                    Auto-update
                  </span>
                )}
              </div>
              {/* #420 — hoist the live generation progress onto the list card so a
                  doc that is generating shows a compact %/section counter, not
                  just a static badge. Subscribes to the same job:lifecycle +
                  job:doc-section bus the detail view uses; the detail view keeps
                  its richer GenerationProgress unchanged. */}
              {doc.status === "generating" && <DocListProgress docId={doc.id} />}
              {doc.generatedAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  Generated: {new Date(doc.generatedAt).toLocaleDateString()}
                </p>
              )}
            </Card>
          ))}
          {docsQuery.data?.length === 0 && (
            <p className="text-muted-foreground col-span-full">
              No documentation generated yet. Click &ldquo;Generate Documentation&rdquo; to start.
            </p>
          )}
        </div>
      )}

      {/* Loading skeleton while fetching detail */}
      {selectedDoc && docDetail.isLoading && (
        <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading document">
          <div className="flex items-center gap-4">
            <div className="h-9 w-20 rounded bg-muted" />
            <div className="h-7 flex-1 rounded bg-muted" />
          </div>
          <div className="flex gap-6">
            <div className="hidden lg:block w-64 shrink-0 space-y-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className="h-4 rounded bg-muted"
                  style={{ width: `${60 + (i % 4) * 10}%` }}
                />
              ))}
            </div>
            <div className="flex-1 space-y-3">
              <div className="h-8 w-1/3 rounded bg-muted" />
              <div className="h-4 w-full rounded bg-muted" />
              <div className="h-4 w-5/6 rounded bg-muted" />
              <div className="h-48 w-full rounded bg-muted mt-4" />
              <div className="h-4 w-full rounded bg-muted" />
              <div className="h-4 w-4/5 rounded bg-muted" />
            </div>
          </div>
        </div>
      )}

      {/* Document detail view */}
      {selectedDoc && docDetail.data && (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              onClick={() => {
                setViewingVersionId(null);
                setSelectedDoc(null);
              }}
            >
              &larr; Back
            </Button>
            {editingTitle ? (
              <form
                className="flex items-center gap-2 flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  commitRename();
                }}
              >
                <Input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="text-xl font-semibold h-9"
                  maxLength={200}
                  autoFocus
                  onKeyDown={(e) => e.key === "Escape" && setEditingTitle(false)}
                />
                <Button type="submit" size="sm" disabled={renameMutation.isPending}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingTitle(false)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <button
                className="text-xl font-semibold flex-1 text-left hover:text-primary transition-colors truncate"
                title="Click to rename"
                onClick={() => startEditTitle(docDetail.data!.title)}
              >
                {docDetail.data.title}
              </button>
            )}
            <Button variant="outline" onClick={() => handleExport(selectedDoc, "pdf")}>
              Export PDF
            </Button>
            <Button variant="outline" onClick={() => handleExport(selectedDoc, "docx")}>
              Export Word
            </Button>
            <Button variant="outline" onClick={() => handleExport(selectedDoc, "markdown")}>
              Export Markdown
            </Button>
            <Button variant="destructive" onClick={() => deleteMutation.mutate(selectedDoc)}>
              Delete
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Generation</span>
            <StatusBadge status={docDetail.data.status} />
            <span>Indexing</span>
            <IndexingBadge state={docDetail.data.indexing?.state} />
            <span data-testid="doc-indexing-summary">
              {formatIndexingSummary(docDetail.data.indexing)}
            </span>
          </div>

          {docDetail.data.status === "generating" && (
            <GenerationProgress
              sections={sectionProgress}
              lifecycleMessage={docJob?.message}
              progress={docJob?.progress}
            />
          )}

          {docDetail.data.status === "failed" && (
            <FailedGenerationBanner
              interrupted={docDetail.data.interrupted === true}
              regenerating={regenerateMutation.isPending}
              onRegenerate={() => regenerateMutation.mutate(docDetail.data.id)}
            />
          )}

          {/* Epic #204 (#225) — surface degraded-output warnings instead of
              silently presenting an incomplete doc as ready. */}
          {docDetail.data.status === "degraded" && (
            <DegradedWarningsBanner
              warnings={docDetail.data.warnings}
              errorMessage={docDetail.data.errorMessage}
            />
          )}

          {/* Document vs Schema Graph tabs (Epic #895 — database docs only). */}
          {canShowSchemaGraphTabs(isDatabaseDoc, docDetail.data.status) && (
            <div className="flex gap-1 border-b" role="tablist" aria-label="Document view">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "document"}
                onClick={() => setDetailTab("document")}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  detailTab === "document"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid="doc-tab-document"
              >
                Document
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "graph"}
                onClick={() => setDetailTab("graph")}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  detailTab === "graph"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid="doc-tab-graph"
              >
                Schema Graph
              </button>
            </div>
          )}

          {/* Schema graph view */}
          {isDatabaseDoc && detailTab === "graph" ? (
            <div data-testid="schema-graph-panel">
              {schemaGraphQuery.isLoading && (
                <div className="flex h-[300px] items-center justify-center rounded-md border text-sm text-muted-foreground">
                  Loading schema graph…
                </div>
              )}
              {schemaGraphQuery.isError && (
                <div className="flex h-[300px] flex-col items-center justify-center gap-3 rounded-md border text-sm text-muted-foreground">
                  <p>This document was generated before the interactive graph feature was added.</p>
                  <p>
                    <strong>Regenerate the document</strong> to build the full Schema Graph with all
                    tables.
                  </p>
                  <Button onClick={() => setShowGenerate(true)}>Regenerate Documentation</Button>
                </div>
              )}
              {schemaGraphQuery.data && <SchemaGraphExplorer graph={schemaGraphQuery.data} />}
            </div>
          ) : (
            (() => {
              // The versions array is ordered version-desc, so the first row is
              // the latest. When the user is viewing a previous version we show
              // that version's stored markdown read-only; otherwise the doc's
              // current content.
              const versions = docDetail.data.versions ?? [];
              const viewing =
                viewingVersionId != null
                  ? versions.find((v) => v.id === viewingVersionId)
                  : undefined;
              const shownContent = viewing
                ? versionBody.data?.id === viewing.id
                  ? versionBody.data.content
                  : undefined
                : docDetail.data.content;
              if (viewing && shownContent === undefined) {
                return (
                  <p
                    className="text-sm text-muted-foreground"
                    role="status"
                    data-testid="version-view-loading"
                  >
                    {versionBody.isError
                      ? `Could not load v${viewing.version}.`
                      : `Loading v${viewing.version}…`}
                  </p>
                );
              }
              return (
                shownContent && (
                  <div>
                    {viewing && (
                      <div
                        className="mb-3 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                        data-testid="version-view-banner"
                      >
                        <span>
                          Viewing v{viewing.version} (read-only) —{" "}
                          {viewing.diffSummary ?? "Full generation"}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setViewingVersionId(null)}
                          data-testid="version-history-back-to-latest"
                        >
                          Back to latest
                        </Button>
                      </div>
                    )}
                    <MarkdownPreviewer content={shownContent} />
                  </div>
                )
              );
            })()
          )}

          {/* Version history — render whenever the detail payload carries
              versions; mark the latest and allow viewing a previous version's
              content read-only. #190 — the body, provenance and changed
              symbols are each fetched only when the user opens them. */}
          {docDetail.data.versions && docDetail.data.versions.length >= 1 && (
            <Card className="p-4" data-testid="version-history">
              <h3 className="font-semibold mb-2">Version History</h3>
              <ul className="space-y-1 text-sm">
                {docDetail.data.versions.map((v, i) => {
                  // Array is ordered version-desc → index 0 is the latest.
                  const isLatest = i === 0;
                  const isViewing = viewingVersionId === v.id;
                  const canView = !isLatest;
                  return (
                    <li key={v.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2">
                          {canView ? (
                            <button
                              type="button"
                              className="text-left text-primary underline hover:no-underline"
                              onClick={() => setViewingVersionId(v.id)}
                              data-testid={`version-view-${v.id}`}
                              aria-pressed={isViewing}
                            >
                              v{v.version}: {v.diffSummary ?? "Full generation"}
                            </button>
                          ) : (
                            <span>
                              v{v.version}: {v.diffSummary ?? "Full generation"}
                            </span>
                          )}
                          {isLatest && (
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                              Current
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground">
                          {new Date(v.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <VersionArtifacts
                        projectId={projectId}
                        docId={selectedDoc}
                        versionId={v.id}
                        version={v.version}
                      />
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function GenerateForm({
  projectId,
  onSubmit,
  onCancel,
  isLoading,
}: {
  projectId: string;
  onSubmit: (
    title: string,
    scope: string,
    docType: string,
    scopeFilter: Record<string, unknown> | undefined,
    groundDomainWithWebResearch: boolean,
    pathPrefixes?: string[],
  ) => void;
  onCancel: () => void;
  isLoading: boolean;
}): React.ReactElement {
  const [docType, setDocType] = useState("business-requirements");
  const defaultTitles: Record<string, string> = {
    "business-requirements": "Business Requirements",
    architecture: "Architecture Overview",
    "user-guide": "User Guide",
  };
  const [title, setTitle] = useState(defaultTitles["business-requirements"]);
  const [scope, setScope] = useState("full");
  const [titleEdited, setTitleEdited] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [selectedDbId, setSelectedDbId] = useState<string>("");
  // #283 — opt-in domain web-research grounding. Default OFF to respect
  // network/cost; only meaningful for narrative business-requirements docs.
  const [groundDomainWithWebResearch, setGroundDomainWithWebResearch] = useState(false);
  // Optional path scope: repository-relative prefixes, comma-separated.
  // The server validates and normalises them; empty means the whole project.
  const [pathScope, setPathScope] = useState("");

  // Fetch repo connectors when scope is "repository"
  const repoConnectorsQuery = useQuery<
    Array<{ id: string; label: string; repoUrl: string; status: string; isPrimary: boolean }>
  >({
    queryKey: ["repo-connectors", projectId],
    queryFn: () =>
      apiFetch(`/projects/${projectId}/connectors/repos`) as Promise<
        Array<{ id: string; label: string; repoUrl: string; status: string; isPrimary: boolean }>
      >,
    enabled: scope === "repository" && Boolean(projectId),
  });

  // Fetch db connectors when scope is "database"
  const dbConnectorsQuery = useQuery<
    Array<{
      id: string;
      label: string;
      driver: string;
      host: string;
      databaseName: string;
      status: string;
    }>
  >({
    queryKey: ["db-connectors", projectId],
    queryFn: () =>
      apiFetch(`/projects/${projectId}/connectors/dbs`) as Promise<
        Array<{
          id: string;
          label: string;
          driver: string;
          host: string;
          databaseName: string;
          status: string;
        }>
      >,
    enabled: scope === "database" && Boolean(projectId),
  });

  const connectedDbs = dbConnectorsQuery.data?.filter((db) => db.status === "connected") ?? [];

  const handleDocTypeChange = (next: string): void => {
    setDocType(next);
    if (!titleEdited) setTitle(defaultTitles[next] ?? "Project Documentation");
  };

  const handleScopeChange = (next: string): void => {
    setScope(next);
    setSelectedRepoId("");
    setSelectedDbId("");
    if (!titleEdited) {
      if (next === "full" || next === "module" || next === "symbol") {
        setTitle(defaultTitles[docType] ?? "Project Documentation");
      }
    }
  };

  const handleRepoChange = (repoId: string): void => {
    setSelectedRepoId(repoId);
    if (!titleEdited) {
      const repo = repoConnectorsQuery.data?.find((r) => r.id === repoId);
      if (repo) setTitle(`${repo.label} ${defaultTitles[docType] ?? "Documentation"}`);
    }
  };

  const handleDbChange = (dbId: string): void => {
    setSelectedDbId(dbId);
    if (!titleEdited) {
      const db = connectedDbs.find((d) => d.id === dbId);
      if (db) setTitle(`${db.label} Schema`);
    }
  };

  const handleSubmit = (): void => {
    const scopeFilter: Record<string, unknown> = {};
    if (scope === "repository" && selectedRepoId) {
      scopeFilter.repoConnectorId = selectedRepoId;
    }
    if (scope === "database" && selectedDbId) {
      scopeFilter.dbConnectorId = selectedDbId;
    }
    // #283 — only forward the opt-in for narrative business-requirements docs
    // where it is meaningful; ignored for other doc types.
    const ground =
      docType === "business-requirements" &&
      (scope === "full" || scope === "repository") &&
      groundDomainWithWebResearch;
    const pathPrefixes =
      scope === "full" || scope === "repository"
        ? pathScope
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : [];
    onSubmit(
      title,
      scope,
      docType,
      Object.keys(scopeFilter).length > 0 ? scopeFilter : undefined,
      ground,
      pathPrefixes.length > 0 ? pathPrefixes : undefined,
    );
  };

  const isSubmitDisabled =
    isLoading ||
    !title.trim() ||
    (scope === "repository" && !selectedRepoId) ||
    (scope === "database" && !selectedDbId);

  return (
    <Card className="p-4 space-y-4" data-testid="generate-form">
      <h3 className="font-semibold">Generate Documentation</h3>

      {/* Scope selector — always visible */}
      <div className="space-y-2">
        <label htmlFor="doc-scope-select" className="text-sm font-medium">
          Scope
        </label>
        <select
          id="doc-scope-select"
          value={scope}
          onChange={(e) => handleScopeChange(e.target.value)}
          className="w-full px-3 py-2 border rounded-md bg-background"
          data-testid="doc-scope-select"
        >
          <option value="full">Full Project</option>
          <option value="repository">By Repository</option>
          <option value="database">Database Schema</option>
          <option value="module">Single Module</option>
          <option value="symbol">Single Symbol</option>
        </select>
      </div>

      {/* Repository connector dropdown — shown when scope is "repository" */}
      {scope === "repository" && (
        <div className="space-y-2">
          <label htmlFor="repo-connector-select" className="text-sm font-medium">
            Repository
          </label>
          <select
            id="repo-connector-select"
            value={selectedRepoId}
            onChange={(e) => handleRepoChange(e.target.value)}
            className="w-full px-3 py-2 border rounded-md bg-background"
            data-testid="repo-connector-select"
            disabled={repoConnectorsQuery.isLoading}
          >
            <option value="">
              {repoConnectorsQuery.isLoading ? "Loading…" : "Select a repository…"}
            </option>
            {repoConnectorsQuery.data?.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.label} — {repo.repoUrl}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Database connector dropdown — shown when scope is "database" */}
      {scope === "database" && (
        <div className="space-y-2">
          <label htmlFor="db-connector-select" className="text-sm font-medium">
            Database
          </label>
          <select
            id="db-connector-select"
            value={selectedDbId}
            onChange={(e) => handleDbChange(e.target.value)}
            className="w-full px-3 py-2 border rounded-md bg-background"
            data-testid="db-connector-select"
            disabled={dbConnectorsQuery.isLoading}
          >
            <option value="">
              {dbConnectorsQuery.isLoading ? "Loading…" : "Select a connected database…"}
            </option>
            {connectedDbs.map((db) => (
              <option key={db.id} value={db.id}>
                {db.label} ({db.driver})
              </option>
            ))}
          </select>
          {!dbConnectorsQuery.isLoading && connectedDbs.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="no-connected-dbs">
              No connected databases found. Connect a database in the Connections tab first.
            </p>
          )}
        </div>
      )}

      {/* Document type — hidden for database scope */}
      {scope !== "database" && (
        <div className="space-y-2">
          <label htmlFor="doc-type-select" className="text-sm font-medium">
            Document Type
          </label>
          <select
            id="doc-type-select"
            value={docType}
            onChange={(e) => handleDocTypeChange(e.target.value)}
            className="w-full px-3 py-2 border rounded-md bg-background"
            data-testid="doc-type-select"
            disabled={scope !== "full" && scope !== "repository"}
          >
            <option value="business-requirements">
              Business Requirements — for analysts &amp; product owners
            </option>
            <option value="architecture">Architecture — for developers &amp; architects</option>
            <option value="user-guide">User Guide — for end users</option>
          </select>
          {scope !== "full" && scope !== "repository" && (
            <p className="text-xs text-muted-foreground">
              Document type only applies when scope is &ldquo;Full Project&rdquo; or &ldquo;By
              Repository&rdquo;.
            </p>
          )}
        </div>
      )}

      {/* #283 — opt-in domain web-research grounding (business-requirements only). */}
      {docType === "business-requirements" && (scope === "full" || scope === "repository") && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={groundDomainWithWebResearch}
              onChange={(e) => setGroundDomainWithWebResearch(e.target.checked)}
              data-testid="ground-domain-web-research"
            />
            Ground domain context with web research
          </label>
          <p className="text-xs text-muted-foreground">
            Runs web research for the project&rsquo;s business domain so narrative sections
            (Overview &amp; Domain, Core Business Capabilities) are grounded in cited sources. Off
            by default — makes external network calls when enabled.
          </p>
        </div>
      )}

      {(scope === "full" || scope === "repository") && (
        <div className="space-y-1">
          <label htmlFor="doc-path-scope-input" className="text-sm font-medium">
            Limit to paths (optional)
          </label>
          <input
            id="doc-path-scope-input"
            type="text"
            value={pathScope}
            onChange={(e) => setPathScope(e.target.value)}
            placeholder="packages/domain/src/workout/, packages/physics/"
            className="w-full px-3 py-2 border rounded-md bg-background"
            data-testid="doc-path-scope-input"
          />
          <p className="text-xs text-muted-foreground">
            Repository-relative path prefixes, comma-separated. Only code under them is documented —
            a fast test run; the document is marked as scoped.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="doc-title-input" className="text-sm font-medium">
          Title
        </label>
        <input
          id="doc-title-input"
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleEdited(true);
          }}
          className="w-full px-3 py-2 border rounded-md bg-background"
          data-testid="doc-title-input"
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={isSubmitDisabled} data-testid="submit-generate">
          {isLoading ? "Generating..." : "Generate"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/**
 * Epic #238 (#243) — live per-section generation progress + degraded/failed
 * warnings, driven by the `job:doc-section` socket events. Replaces the old
 * static "generating..." card so users see which sections succeeded/failed
 * DURING generation rather than after a manual refresh.
 */
function GenerationProgress({
  sections,
  lifecycleMessage,
  progress,
}: {
  sections: Record<string, DocSectionProgressEvent>;
  lifecycleMessage?: string;
  progress?: number;
}): React.ReactElement {
  const rows = Object.values(sections).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const statusStyle: Record<DocSectionProgressEvent["status"], string> = {
    queued: "text-gray-500",
    generating: "text-yellow-700 animate-pulse",
    done: "text-green-700",
    degraded: "text-amber-700",
    failed: "text-red-700",
  };
  const statusLabel: Record<DocSectionProgressEvent["status"], string> = {
    queued: "Queued",
    generating: "Generating…",
    done: "Done",
    // "Needs review" not "Degraded": a flagged section means some statements
    // couldn't be auto-verified against the retrieved source, not that the
    // content is wrong (the dominant causes are retrieval gaps + inferred
    // structure). See DegradedWarningsBanner / the server warning copy.
    degraded: "Needs review",
    failed: "Failed",
  };
  return (
    // #662 — SC 2.2.2 Pause, Stop, Hide. Documentation generation is a
    // multi-minute run that streams per-section progress into this live region;
    // PausableLiveRegion adds a keyboard-operable control to pause the updates
    // and silence announcements. It renders only while generating, so the
    // control is never stranded.
    <PausableLiveRegion
      label="Generation progress"
      testId="generation-progress"
      className="rounded-xl border bg-card p-4 text-card-foreground shadow"
    >
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground animate-pulse">
          {lifecycleMessage ?? "Generating documentation… This may take a minute."}
        </p>
        {typeof progress === "number" && (
          <span className="text-sm font-medium text-muted-foreground">{progress}%</span>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm" data-testid="section-progress-list">
          {rows.map((s) => (
            <li key={s.section} className="flex items-start justify-between gap-3">
              <span className="truncate">
                {s.index ? `${s.index}. ` : ""}
                {s.section}
              </span>
              <span className={`shrink-0 font-medium ${statusStyle[s.status]}`}>
                {statusLabel[s.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Surface section-level warnings live (#243), not just after refresh. */}
      {rows.some((s) => s.warning) && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-800">
          {rows
            .filter((s) => s.warning)
            .map((s) => (
              <li key={`${s.section}-warn`}>{s.warning!.message}</li>
            ))}
        </ul>
      )}
    </PausableLiveRegion>
  );
}

/**
 * Epic #406 (#420) — compact live generation progress for a documentation LIST
 * card. Subscribes per-doc to the SAME unified job bus the detail view uses
 * (`job:lifecycle` for the overall % + `job:doc-section` for section counts), so
 * the list card shows real progress instead of a static "generating" badge. The
 * richer per-section detail stays in the detail view's `GenerationProgress` —
 * this is intentionally the compact variant (one bar + an "N of M sections"
 * counter). Exported for unit testing.
 */
export function DocListProgress({ docId }: { docId: string }): React.ReactElement {
  const sections = useDocSectionProgress(docId);
  const job = useJobLifecycle(docId);

  const rows = Object.values(sections);
  // Prefer a real section index/total from the bus (preserves the existing
  // "Loading… (9 of 51 tables)"-style counter). `total` is the document's total
  // section count; `done` is how many have reached a terminal section state.
  const total = rows.reduce((max, s) => Math.max(max, s.total ?? 0), 0);
  const done = rows.filter(
    (s) => s.status === "done" || s.status === "degraded" || s.status === "failed",
  ).length;

  // Percent: prefer the lifecycle progress (0-100); else derive from sections.
  const pct =
    typeof job?.progress === "number"
      ? job.progress
      : total > 0
        ? Math.round((done / total) * 100)
        : undefined;

  const counter = total > 0 ? `${done} of ${total} sections` : (job?.message ?? "Generating…");

  return (
    <div className="mt-2 space-y-1" data-testid={`doc-list-progress-${docId}`} aria-live="polite">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="truncate" data-testid={`doc-list-progress-counter-${docId}`}>
          {counter}
        </span>
        {typeof pct === "number" && (
          <span className="font-medium" data-testid={`doc-list-progress-pct-${docId}`}>
            {Math.round(pct)}%
          </span>
        )}
      </div>
      <Progress value={typeof pct === "number" ? pct : undefined} className="h-1.5" />
    </div>
  );
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colors: Record<string, string> = {
    ready: "bg-green-100 text-green-700",
    generating: "bg-yellow-100 text-yellow-700",
    pending: "bg-gray-100 text-gray-700",
    failed: "bg-red-100 text-red-700",
    // Epic #204 (#225) — degraded sits between ready and failed: content exists
    // but some sections failed or couldn't be auto-verified against source.
    degraded: "bg-amber-100 text-amber-800",
  };
  // Friendly label: show "needs review" rather than the raw "degraded" status —
  // a flagged doc is for review, not necessarily inaccurate.
  const labels: Record<string, string> = { degraded: "needs review" };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[status] ?? colors.pending}`}>
      {labels[status] ?? status}
    </span>
  );
}

function IndexingBadge({ state }: { state?: string | null }): React.ReactElement {
  const normalized = state ?? "pending";
  const colors: Record<string, string> = {
    indexed: "bg-emerald-100 text-emerald-700",
    pending: "bg-slate-100 text-slate-700",
    quarantined: "bg-amber-100 text-amber-800",
    rejected: "bg-rose-100 text-rose-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded ${colors[normalized] ?? colors.pending}`}
      data-testid="doc-indexing-badge"
    >
      {normalized}
    </span>
  );
}

function formatIndexingSummary(indexing?: GeneratedDoc["indexing"]): string {
  if (!indexing) return "Queued for indexing.";
  switch (indexing.state) {
    case "indexed":
      return `${indexing.chunkCount} chunks indexed.`;
    case "quarantined":
      return "Awaiting approval before indexing.";
    case "rejected":
      return indexing.errorMessage?.trim() || "Indexing was rejected.";
    default:
      return indexing.errorMessage?.trim() || "Queued for indexing.";
  }
}

/**
 * Epic #204 (#225) / follow-up (#252) — resolve the degraded-output warnings to
 * render. Prefers the dedicated structured `warnings` column; falls back to
 * parsing the legacy `errorMessage` JSON for docs persisted before the #252
 * migration. Exported for unit testing.
 *
 * #86 — the legacy fallback is kept, and it is safe because the SERVER sanitises
 * that column now: `publicGenerationErrorMessage` re-derives every
 * `section-failed` warning in a pre-#252 blob through the fixed
 * `generationFailureMessage` vocabulary, and collapses anything that is not a
 * warning list (a raw exception string a pre-#52 row left behind) to a fixed
 * message. Before that fix this parse rendered `String(err)` — provider
 * response bodies, absolute paths, SQL text — verbatim in the banner, which is
 * exactly the exposure #67 closed for the `warnings` column. Do not start
 * trusting this input on the strength of that: it is sanitised upstream, not
 * sanitised here.
 */
export function resolveDocWarnings(
  structuredWarnings?: DocWarning[] | null,
  errorMessage?: string | null,
): DocWarning[] {
  if (structuredWarnings && structuredWarnings.length > 0) {
    // #252 — structured warnings from the dedicated column.
    return structuredWarnings.filter(
      (w): w is DocWarning => !!w && typeof w === "object" && typeof w.message === "string",
    );
  }
  if (errorMessage) {
    // Legacy fallback: pre-#252 degraded docs stored DocWarning[] JSON here.
    try {
      const parsed: unknown = JSON.parse(errorMessage);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (w): w is DocWarning =>
            !!w && typeof w === "object" && typeof (w as DocWarning).message === "string",
        );
      }
    } catch {
      // Non-JSON errorMessage — show it as a single generic warning.
      return [{ kind: "section-failed", section: "", message: errorMessage, severity: "error" }];
    }
  }
  return [];
}

/**
 * Tier-aware expected-range tag appended to a section's detail line so each
 * flagged section is read in the right light. `narrative`/`reconstruction`
 * sections are inferred/domain BY DESIGN (within normal tolerance); a `literal`
 * code-derived section below its bar is the one worth verifying. Returns an empty
 * string when there is no tier to annotate (failure/legacy/no-modules warnings).
 * Exported for unit testing.
 */
export function tierRangeTag(w: DocWarning): string {
  switch (w.tier) {
    case "narrative":
      return " — narrative section, within expected range; enable web research to raise";
    case "reconstruction":
      return " — reconstruction section, inferred; verify against source";
    case "literal":
      return " — below the code-fidelity bar, review";
    default:
      return "";
  }
}

/**
 * Issue #273 — format a single warning's detail line, appending the numeric
 * faithfulness ratio + threshold when the (entailment-based) scorer attached
 * them, plus a tier-aware expected-range tag. Falls back to the plain message for
 * failure/legacy warnings. Exported for unit testing.
 */
export function formatWarningDetail(w: DocWarning): string {
  // #283 — narrative/domain-context warnings carry their own honest, complete
  // sentence ("X% of claims are grounded in source code; the remainder provide
  // domain/business context…"). Appending a "[faithfulness X% (threshold Y%)]"
  // suffix would re-introduce the alarming, deficiency-framed numbers, so render
  // the message as-is — but still append the short tier tag so the expected
  // range is explicit.
  if (w.domainContext) return `${w.message}${tierRangeTag(w)}`;
  if (typeof w.ratio === "number") {
    const pct = Math.round(w.ratio * 100);
    const thresholdPct =
      typeof w.threshold === "number" ? ` (threshold ${Math.round(w.threshold * 100)}%)` : "";
    return `${w.message} [faithfulness ${pct}%${thresholdPct}]${tierRangeTag(w)}`;
  }
  return `${w.message}${tierRangeTag(w)}`;
}

/**
 * Tier-aware severity classification for the degraded-output banner. The
 * document is flagged `degraded` whenever ANY section misses ITS faithfulness
 * threshold, but the three tiers carry very different meaning:
 *
 *  - `narrative` / `reconstruction` sections are inferred/domain BY DESIGN, so a
 *    below-bar result is **within normal tolerance** — not evidence the doc is
 *    inaccurate.
 *  - a `literal` code-derived section below its strict bar, a `section-failed`
 *    section, or a `no-modules` result is genuinely **worth verifying**.
 *
 * Returns whether review is recommended and, if so, the distinct section labels
 * that drive that recommendation (so the headline can name them rather than
 * fabricate an "N of M" count we don't have — the warnings list contains only
 * FLAGGED sections, never the document total). Exported for unit testing.
 */
export function classifyWarningSeverity(warnings: DocWarning[]): {
  /** True when at least one section genuinely warrants a manual look. */
  reviewRecommended: boolean;
  /** Distinct labels of the concerning sections (deduped, order-preserved). */
  concerningSections: string[];
} {
  const concerning = warnings.filter((w) => {
    // Hard failures, empty-document signals, and #330 source-unavailability
    // (the doc was built from little/no source) are always concerning.
    if (w.kind === "section-failed" || w.kind === "no-modules" || w.kind === "source-unavailable")
      return true;
    // A literal code-derived section below its bar is worth verifying.
    if (w.tier === "literal") return true;
    // Within-tolerance tiers (narrative/reconstruction) are NOT concerning.
    if (w.tier === "narrative" || w.tier === "reconstruction") return false;
    // Back-compat: a pre-tier narrative note carries domainContext.
    if (w.domainContext === true) return false;
    // Unknown/legacy `section-ungrounded` with no tier and no domainContext:
    // we cannot prove it is within tolerance, so treat it as concerning.
    return true;
  });
  const concerningSections = Array.from(
    new Set(
      concerning.map((w) => w.section).filter((s): s is string => !!s && s.trim().length > 0),
    ),
  );
  return { reviewRecommended: concerning.length > 0, concerningSections };
}

/**
 * #50 — a `failed` document: why, and a one-click regenerate of the same doc.
 * The server's raw error string is deliberately not shown (#254); an
 * interruption by a restart gets its own explanation because the user did
 * nothing wrong and simply needs to run it again. Exported for unit testing.
 */
export function FailedGenerationBanner({
  interrupted,
  regenerating,
  onRegenerate,
}: {
  interrupted: boolean;
  regenerating: boolean;
  onRegenerate: () => void;
}): React.ReactElement {
  return (
    <Card className="border-red-300 bg-red-50 p-4" role="alert">
      <p className="font-medium text-red-900">
        {interrupted ? "Generation was interrupted" : "Generation failed"}
      </p>
      <p className="mt-1 text-sm text-red-800">
        {interrupted
          ? "The server restarted or stopped while this document was being generated, so it never finished. Regenerating reuses the modules already analysed before the interruption."
          : "This document could not be generated. You can try again; if it keeps failing, check the server logs."}
      </p>
      <Button className="mt-3" size="sm" onClick={onRegenerate} disabled={regenerating}>
        {regenerating ? "Regenerating…" : "Regenerate"}
      </Button>
    </Card>
  );
}

/**
 * Epic #204 (#225) / follow-up (#252) — renders degraded-output warnings.
 * Exported for unit testing.
 */
export function DegradedWarningsBanner({
  warnings: structuredWarnings,
  errorMessage,
}: {
  warnings?: DocWarning[] | null;
  errorMessage?: string | null;
}): React.ReactElement {
  const warnings = resolveDocWarnings(structuredWarnings, errorMessage);

  // Tier-aware headline. A doc is flagged `degraded` whenever ANY section misses
  // ITS faithfulness bar, but narrative/reconstruction sections are inferred/
  // domain BY DESIGN — a below-bar result there is within normal tolerance, not
  // evidence the doc is inaccurate. Only a literal code-derived section below its
  // strict bar, a failed section, or a no-modules result genuinely warrants a
  // look. We deliberately do NOT fabricate an "N of M sections" count: the
  // warnings list contains only FLAGGED sections, never the document total.
  const { reviewRecommended, concerningSections } = classifyWarningSeverity(warnings);

  const headline = reviewRecommended
    ? concerningSections.length > 0
      ? `Most sections are grounded; ${formatSectionList(concerningSections)} ${
          concerningSections.length === 1 ? "falls" : "fall"
        } short of the code-fidelity bar and ${
          concerningSections.length === 1 ? "is" : "are"
        } worth verifying.`
      : "Most sections are grounded; the sections below fall short of the code-fidelity bar and are worth verifying."
    : "Grounded within normal tolerance — some narrative/reconstruction sections blend source-code facts with inferred domain context (expected for these section types). See the breakdown below.";

  return (
    <Card className="border-amber-300 bg-amber-50 p-4" role="alert">
      <p className="font-medium text-amber-900">{headline}</p>
      {warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
          {warnings.map((w, i) => (
            <li key={i}>{formatWarningDetail(w)}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-amber-700">
        Flagged sections contain statements that could not be automatically verified against the
        retrieved source — this does not by itself mean they are inaccurate (the supporting code may
        simply not have been retrieved). Statements the model inferred from the code are tagged{" "}
        <code className="rounded bg-amber-100 px-1">_(inferred)_</code> inline, so you can tell
        verified facts from inferred ones.
      </p>
    </Card>
  );
}

/**
 * #1228 — may the Document / Schema Graph tab strip be shown?
 *
 * The strip is the ONLY control that can set `detailTab` to `"graph"`, so
 * hiding it hides the schema explorer outright. It used to require
 * `status === "ready"`, which was indistinguishable from "this document has a
 * graph" only because a database document could never be anything else. Once
 * failed table prose marks one `degraded` (#1228), that gate would hide the
 * explorer for exactly the documents whose prose failed — even though the graph
 * itself is complete, `GET /:docId/schema-graph` applies no status filter, and
 * the export route's own query already whitelists `degraded`.
 *
 * Still excluded: `pending`, `generating` and `failed`, where there is no
 * persisted graph to show.
 */
export function canShowSchemaGraphTabs(
  isDatabaseDoc: boolean,
  status: string | null | undefined,
): boolean {
  return isDatabaseDoc && (status === "ready" || status === "degraded");
}

/**
 * Join section labels into a readable, quoted, comma/“and”-separated phrase for
 * the review-recommended headline (e.g. `"A"`, `"A" and "B"`, `"A", "B" and "C"`).
 * Exported for unit testing.
 */
export function formatSectionList(sections: string[]): string {
  const quoted = sections.map((s) => `"${s}"`);
  if (quoted.length === 0) return "the sections below";
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}
