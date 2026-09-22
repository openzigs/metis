"use client";

/**
 * Job-lifecycle socket consumer — Epic #238 (#240 + #243).
 *
 * Subscribes to the unified `job:lifecycle` and per-section `job:doc-section`
 * events emitted by the server (#239) and turns them into:
 *   - live status for a specific job (`useJobLifecycle`), and
 *   - TanStack Query cache invalidation so analysis / impact / doc-generation
 *     screens update on push instead of requiring a manual refresh
 *     (`useProjectJobEvents`).
 *
 * Polling is intentionally KEPT in the consuming hooks as a degraded fallback;
 * this layer only adds push so a disconnected socket still converges via poll.
 *
 * The browser socket is loosely typed, so events are subscribed via the
 * `socket.on("name" as never, handler as never)` escape hatch used elsewhere in
 * the UI (see `use-connector-events.ts`).
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DocSectionProgressEvent, JobKind, JobLifecycleEvent } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { queryKeys } from "@/lib/query-keys";
import { impactAnalysisKeys } from "@/lib/impact-analysis-hooks";

/**
 * Subscribe to a single job's lifecycle and return its latest event. Used by the
 * doc-generation row, analysis detail, and impact detail to drive live status.
 */
export function useJobLifecycle(jobId: string | null | undefined): JobLifecycleEvent | null {
  const socket = useSocket();
  const [event, setEvent] = useState<JobLifecycleEvent | null>(null);

  useEffect(() => {
    if (!socket || !jobId) return;
    socket.emit("subscribe:job", { jobId });
    const onLifecycle = (data: JobLifecycleEvent) => {
      if (data.jobId === jobId) setEvent(data);
    };
    socket.on("job:lifecycle" as never, onLifecycle as never);
    return () => {
      socket.emit("unsubscribe:job", { jobId });
      socket.off("job:lifecycle" as never, onLifecycle as never);
    };
  }, [socket, jobId]);

  return event;
}

/** Latest per-section progress for a doc-generation job, keyed by section label. */
export function useDocSectionProgress(
  jobId: string | null | undefined,
): Record<string, DocSectionProgressEvent> {
  const socket = useSocket();
  const [sections, setSections] = useState<Record<string, DocSectionProgressEvent>>({});

  useEffect(() => {
    if (!socket || !jobId) {
      setSections({});
      return;
    }
    socket.emit("subscribe:job", { jobId });
    const onSection = (data: DocSectionProgressEvent) => {
      if (data.jobId !== jobId) return;
      setSections((prev) => ({ ...prev, [data.section]: data }));
    };
    socket.on("job:doc-section" as never, onSection as never);
    return () => {
      socket.emit("unsubscribe:job", { jobId });
      socket.off("job:doc-section" as never, onSection as never);
    };
  }, [socket, jobId]);

  return sections;
}

/**
 * Map a job kind to the query keys that should be invalidated on a transition.
 *
 * The original three kinds (#239) have bespoke target lists. Every other kind —
 * including the long-running ops added by Epic #406 (#419): `scan`, `pr-review`,
 * `import-sync`, `embeddings-reindex`, `spec-kit`, `overview-regenerate` — falls
 * through to a generic, project-scoped default that invalidates the project
 * detail cache so whatever surface is showing that project converges. This means
 * a brand-new `JobKind` needs NO edit here: it gets sensible refresh behavior for
 * free. A kind only needs a `case` if it wants more targeted invalidation.
 */
function invalidationKeysFor(kind: JobKind, projectId: string): readonly (readonly unknown[])[] {
  switch (kind) {
    case "analysis":
      return [queryKeys.analyses.forProject(projectId)];
    case "doc-generation":
      // The Documentation list keys generated docs separately from uploaded
      // documents (#29); without it a finished run kept its "generating" badge.
      return [
        queryKeys.documents.forProject(projectId),
        queryKeys.generatedDocs.forProject(projectId),
      ];
    case "impact-analysis":
      return [impactAnalysisKeys.list()];
    default:
      // Generic default for any current or future kind: refresh the project
      // surface so its job/list views re-fetch on the transition.
      return [queryKeys.projects.detail(projectId)];
  }
}

/**
 * Project-scoped consumer (#240): joins the `project:{id}` room and invalidates
 * the relevant TanStack Query caches whenever a job in that project transitions,
 * so analysis / doc-generation lists converge without polling or manual refresh.
 *
 * Returns the latest lifecycle event seen (any kind) for optional banner UI.
 */
export function useProjectJobEvents(
  projectId: string | null | undefined,
): JobLifecycleEvent | null {
  const socket = useSocket();
  const queryClient = useQueryClient();
  const [last, setLast] = useState<JobLifecycleEvent | null>(null);

  useEffect(() => {
    if (!socket || !projectId) return;
    socket.emit("subscribe:project", { projectId });

    const onLifecycle = (data: JobLifecycleEvent) => {
      if (data.projectId && data.projectId !== projectId) return;
      setLast(data);
      // Refresh the affected caches on every transition (started flips a list
      // into a running state; completed/failed pull the final result).
      for (const key of invalidationKeysFor(data.kind, projectId)) {
        void queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
      // Doc-generation completion also refreshes the single-doc detail caches.
      if (data.kind === "doc-generation") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.documents.all });
      }
    };

    socket.on("job:lifecycle" as never, onLifecycle as never);
    return () => {
      socket.off("job:lifecycle" as never, onLifecycle as never);
    };
  }, [socket, projectId, queryClient]);

  return last;
}
