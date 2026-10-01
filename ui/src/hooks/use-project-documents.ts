"use client";

/**
 * The project documents list, kept fresh while anything is still ingesting.
 *
 * Ingest runs in the background: an upload returns with the new document
 * `pending`, and it turns `ready` later. The `document:status` socket event
 * invalidates the list on each transition; the poll is a degraded fallback for
 * a socket that is not connected. #69 — a quarantined document is waiting for
 * a reviewer, not ingesting, so it does not keep the poll running.
 *
 * #322 — shared by every page that lists a project's documents. The Analysis
 * page used to read the list once and re-read it only right after an upload,
 * so a document still `pending` at that moment stayed unselectable until a
 * page reload.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsApi } from "@/lib/projects-api";
import { isDocumentIngesting } from "@/lib/project-pipeline";
import { queryKeys } from "@/lib/query-keys";
import { useSocket } from "@/lib/socket-client";
import { keepSubscribed } from "@/lib/socket-subscription";

/** How often the list is re-read while a document is still ingesting. */
export const DOCUMENT_INGEST_POLL_MS = 3000;

export function useProjectDocuments(projectId: string) {
  const qc = useQueryClient();
  const socket = useSocket();

  const docs = useQuery({
    queryKey: queryKeys.documents.forProject(projectId),
    queryFn: () => documentsApi.list(projectId),
    enabled: Boolean(projectId),
    refetchInterval: (query) =>
      query.state.data?.items.some(isDocumentIngesting) ? DOCUMENT_INGEST_POLL_MS : false,
  });

  useEffect(() => {
    if (!socket || !projectId) return;
    const refresh = () =>
      qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(projectId) });
    // #642 — re-join on reconnect; the server drops rooms with the old session.
    // #646 — and re-read the list, for a `document:status` sent during the gap.
    const release = keepSubscribed(
      socket,
      () => socket.emit("subscribe:project", { projectId }),
      refresh,
    );
    const onDocumentStatus = (data: { projectId: string }) => {
      if (data.projectId !== projectId) return;
      refresh();
    };
    socket.on("document:status" as never, onDocumentStatus as never);
    return () => {
      release();
      socket.off("document:status" as never, onDocumentStatus as never);
    };
  }, [socket, qc, projectId]);

  return docs;
}
