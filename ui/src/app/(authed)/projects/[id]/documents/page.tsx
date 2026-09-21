"use client";

/**
 * Project Documents (N3 #141) — split out of the former kitchen-sink project
 * index page. Hosts the document list, uploader, URL ingest, and text ingest.
 */
import { useEffect } from "react";
import { notFound, useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsApi, projectsApi } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useSocket } from "@/lib/socket-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { DocumentUploader } from "@/components/projects/document-uploader";
import { UrlIngestForm } from "@/components/projects/url-ingest-form";
import { TextIngestForm } from "@/components/projects/text-ingest-form";

const INGESTING_STATUSES = new Set(["pending", "queued", "processing"]);

export default function ProjectDocumentsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const socket = useSocket();

  const project = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });

  const docs = useQuery({
    queryKey: queryKeys.documents.forProject(id),
    queryFn: () => documentsApi.list(id),
    enabled: Boolean(id),
    // Ingest runs in the background (issue: list showed stale "queued · 0
    // chunks" forever). The `document:status` socket event below invalidates
    // on push; this poll is a degraded fallback for a disconnected socket.
    refetchInterval: (query) =>
      query.state.data?.items.some((d) => INGESTING_STATUSES.has(d.status)) ? 3000 : false,
  });

  // Live-update the list on ingest transitions instead of relying solely on
  // the one-shot invalidation fired right after upload (#see documents page).
  useEffect(() => {
    if (!socket || !id) return;
    socket.emit("subscribe:project", { projectId: id });
    const onDocumentStatus = (data: { projectId: string }) => {
      if (data.projectId !== id) return;
      qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(id) });
    };
    socket.on("document:status" as never, onDocumentStatus as never);
    return () => {
      socket.off("document:status" as never, onDocumentStatus as never);
    };
  }, [socket, qc, id]);

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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Upload files, ingest URLs, or paste text to add to this project&apos;s knowledge base.
        </p>
      </header>

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
            {docs.data.items.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
                data-testid={`document-row-${d.id}`}
              >
                <div>
                  <p className="font-medium">{d.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.status} · {d.chunkCount} chunks · {(d.sizeBytes / 1024).toFixed(1)} KB
                    {d.errorMessage ? ` · ${d.errorMessage}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeDoc.mutate(d.id)}
                  disabled={removeDoc.isPending}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No documents yet.</p>
        )}
      </Card>
    </div>
  );
}
