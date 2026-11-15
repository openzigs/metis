"use client";

/**
 * Project Documents (N3 #141) — split out of the former kitchen-sink project
 * index page. Hosts the document list, uploader, URL ingest, and text ingest.
 */
import Link from "next/link";
import { useState } from "react";
import { notFound, useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPermission } from "@metis/shared";
import { useAuth } from "@/lib/auth-context";
import { documentsApi, projectsApi, type DocumentRow } from "@/lib/projects-api";
import { isUnreadableDocument } from "@/lib/document-access";
import { ApiError } from "@/lib/api-client";
import { isDocumentAwaitingReview, quarantineHref } from "@/lib/project-pipeline";
import { queryKeys } from "@/lib/query-keys";
import { useProjectDocuments } from "@/hooks/use-project-documents";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { DocumentUploader } from "@/components/projects/document-uploader";
import { UrlIngestForm } from "@/components/projects/url-ingest-form";
import { TextIngestForm } from "@/components/projects/text-ingest-form";
import { PageHeader } from "@/components/ui/page-header";
import { DocumentName } from "@/components/projects/document-name";
import { useRepoNames } from "@/hooks/use-repo-names";
import { PortfolioCheckLink } from "@/components/portfolio/portfolio-check-link";
import { AclEditor } from "@/components/projects/acl-editor";
import { RestrictedBadge } from "@/components/projects/restricted-badge";

/**
 * #69 — what one row says about itself. A quarantined document keeps
 * `status = processing`, so printing the raw status called it "processing"
 * indefinitely with nothing pointing at the reviewer queue it is actually
 * waiting on.
 */
function documentStatusLabel(d: DocumentRow): string {
  return isDocumentAwaitingReview(d) ? "awaiting review" : d.status;
}

export default function ProjectDocumentsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const { user } = useAuth();
  // #2547 — `PATCH /documents/:id/acl` checks `document.upload`.
  const canEditAccess = user ? hasPermission(user.role, "document.upload") : false;
  const [accessOpenFor, setAccessOpenFor] = useState<string | null>(null);

  const project = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });

  // Polls while anything is ingesting and re-reads on `document:status`.
  const docs = useProjectDocuments(id);
  // #363 — repository names, fetched only when a repository file is listed.
  // #547 — classified by stored source, not by a filename an upload can mimic.
  const hasRepoDocs = (docs.data?.items ?? []).some((d) => d.source === "repo");
  const repoNames = useRepoNames(hasRepoDocs ? id : null);

  const removeDoc = useMutation({
    mutationFn: (documentId: string) => documentsApi.remove(id, documentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(id) }),
  });

  if (!id) return <div className="p-6">Invalid project id.</div>;

  // A missing project (404) renders the shared not-found boundary (#143)
  // rather than a half-rendered Documents shell for a project that isn't there.
  if (project.error instanceof ApiError && project.error.status === 404) {
    notFound();
  }

  const isArchived = project.data?.status === "archived";

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-documents-root">
      <PageHeader
        title="Documents"
        description={
          <>
            Upload files, ingest URLs, or paste text to add to this project&apos;s knowledge base.
          </>
        }
      />

      <Card className="space-y-4 p-4">
        <h2 className="text-lg font-semibold">Add documents</h2>
        {!isArchived ? (
          <div className="space-y-3">
            <DocumentUploader
              projectId={id}
              onUploaded={() =>
                qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(id) })
              }
            />
            <UrlIngestForm
              projectId={id}
              onIngested={() =>
                qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(id) })
              }
            />
            <TextIngestForm
              projectId={id}
              onIngested={() =>
                qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(id) })
              }
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This project is archived; uploads are disabled.
          </p>
        )}
        {docs.isLoading ? (
          <SkeletonText lines={3} label="Loading documents…" />
        ) : docs.data && docs.data.items.length > 0 ? (
          <ul className="divide-y" data-testid="document-list">
            {docs.data.items.map((d) => {
              // #2546 / #2547 — a member the document is restricted away from may
              // not change its list (the server refuses it) nor start a check from it.
              const unreadable = isUnreadableDocument(d);
              const accessOpen = accessOpenFor === d.id;
              return (
                <li
                  key={d.id}
                  className="space-y-2 py-2 text-sm"
                  data-testid={`document-row-${d.id}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <DocumentName
                        filename={d.filename}
                        source={d.source}
                        repoNames={repoNames}
                        className="font-medium"
                      />
                      <p className="text-xs text-muted-foreground">
                        {documentStatusLabel(d)} · {d.chunkCount}{" "}
                        {d.chunkCount === 1 ? "section" : "sections"} indexed ·{" "}
                        {(d.sizeBytes / 1024).toFixed(1)} KB
                        {d.errorMessage ? ` · ${d.errorMessage}` : ""}
                      </p>
                      <RestrictedBadge
                        access={unreadable ? { restricted: true, canRead: false } : d.access}
                        testId={`document-restricted-badge-${d.id}`}
                      />
                      {/* #2546 — its access list does not name the caller. */}
                      {unreadable ? (
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid={`document-restricted-${d.id}`}
                        >
                          You don&apos;t have access to this document, so its name is hidden and
                          your analyses don&apos;t read it.
                        </p>
                      ) : null}
                      {isDocumentAwaitingReview(d) ? (
                        <Link
                          href={quarantineHref(id)}
                          className="text-xs underline"
                          data-testid={`document-quarantine-link-${d.id}`}
                        >
                          Review in quarantine
                        </Link>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {/* #2272 — each requirement the document holds, checked across the portfolio.
                          #2546 — not offered for one the caller cannot read. */}
                      {d.source !== "repo" && d.status === "ready" && !unreadable ? (
                        <PortfolioCheckLink
                          from={{ documentId: d.id, title: d.title ?? d.filename }}
                          label="Check requirements across portfolio"
                        />
                      ) : null}
                      {canEditAccess && !isArchived && !unreadable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={accessOpen}
                          onClick={() => setAccessOpenFor(accessOpen ? null : d.id)}
                          data-testid={`document-access-toggle-${d.id}`}
                        >
                          {accessOpen ? "Close access" : "Access"}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeDoc.mutate(d.id)}
                        disabled={removeDoc.isPending}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  {accessOpen ? (
                    <AclEditor
                      projectId={id}
                      documentId={d.id}
                      initialSubjects={d.access?.subjects ?? []}
                      onSaved={() => setAccessOpenFor(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            data-testid="project-documents-empty"
            title="No documents yet."
            description="Specifications, policies and notes about the system belong here. Upload a file, a web page or text above; METIS indexes it for analyses and chat."
          />
        )}
      </Card>
    </div>
  );
}
