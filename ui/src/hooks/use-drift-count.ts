"use client";

/**
 * Issue #78 — pending-drift count for a project, kept live.
 *
 * The count comes from `GET /sync/drift/count` (permission-checked, `sync.read`)
 * and is re-read on the `drift:detected` push the reconciler now emits to the
 * `project:{id}` room. The socket payload is identifier-only by design, so this
 * deliberately re-reads rather than incrementing a local number: a push may
 * arrive for a drift that was resolved in another tab, and an incremented
 * counter would then be wrong until a reload.
 *
 * The socket is shared across the app, so the handler filters on `projectId` —
 * without that, drift on any project would move every badge.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocket } from "@/lib/socket-client";
import { fetchDriftCount } from "@/lib/sync-api";

/** Query key for one project's pending-drift count. */
export function driftCountKey(projectId: string): readonly string[] {
  return ["sync", "drift-count", projectId];
}

/**
 * The project's pending-drift count, or 0 while it is loading or unreadable.
 * A failure is deliberately NOT surfaced: the badge is an at-a-glance extra on
 * a page full of other stages, and an error banner for it would be noise.
 */
export function useProjectDriftCount(projectId: string): number {
  const qc = useQueryClient();
  const socket = useSocket();

  const query = useQuery({
    queryKey: driftCountKey(projectId),
    queryFn: () => fetchDriftCount(projectId),
    enabled: Boolean(projectId),
    retry: false,
  });

  useEffect(() => {
    if (!socket || !projectId) return;
    socket.emit("subscribe:project", { projectId });
    const onDrift = (data: { projectId: string }) => {
      if (data.projectId !== projectId) return;
      void qc.invalidateQueries({ queryKey: driftCountKey(projectId) });
    };
    socket.on("drift:detected" as never, onDrift as never);
    return () => {
      socket.off("drift:detected" as never, onDrift as never);
    };
  }, [socket, qc, projectId]);

  return query.data ?? 0;
}
