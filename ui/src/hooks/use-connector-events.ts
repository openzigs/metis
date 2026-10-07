"use client";

/**
 * Hook: connector progress + discovery Socket.IO events (#664, #669).
 *
 * Subscribes to `connector:progress` and `connector:discovery` events
 * in the project room, exposing current progress state and discovery
 * notifications.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSocket } from "@/lib/socket-client";
import { keepSubscribed } from "@/lib/socket-subscription";
import { projectJoin } from "@/lib/socket-rooms";
import { isDeterminate } from "@/lib/connector-progress";

export interface ConnectorProgress {
  connectorId: string;
  phase: string;
  step: string;
  current?: number;
  total?: number;
  status?: "running" | "error";
  errorMessage?: string;
  ts: number;
}

export interface ConnectorDiscovery {
  projectId: string;
  connectorId: string;
  repoLabel: string;
  connectionsFound: number;
  ts: number;
}

/** How long a run's entry stays after it reaches `current >= total`. */
const COMPLETED_CLEAR_MS = 2000;
/**
 * #762 — how long a count-less entry (a connection test, a metadata fetch)
 * stays without a newer event. The server never sends such a run a terminal
 * event, so without this its row stayed under the card until navigation.
 */
export const INDETERMINATE_CLEAR_MS = 4000;

export interface UseConnectorProgressOptions {
  /**
   * #762 — called once a connector's run ends: its last step was reached
   * (`current >= total`) or it reported an error. By then the server has
   * written the connector's status and commit, so this is where a page
   * refetches the connector. The auto-ingest a new connector triggers has no
   * job id, so this is the only completion signal the page gets.
   */
  onSettled?: (connectorId: string) => void;
}

/**
 * Listens for connector progress events in a project room.
 * Returns a map of connectorId → latest progress.
 */
export function useConnectorProgress(projectId: string, opts: UseConnectorProgressOptions = {}) {
  const socket = useSocket();
  const [progressMap, setProgressMap] = useState<Record<string, ConnectorProgress>>({});
  const mapRef = useRef(progressMap);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const onSettledRef = useRef(opts.onSettled);
  onSettledRef.current = opts.onSettled;

  const update = useCallback(
    (fn: (prev: Record<string, ConnectorProgress>) => Record<string, ConnectorProgress>) => {
      mapRef.current = fn(mapRef.current);
      setProgressMap(mapRef.current);
    },
    [],
  );

  const cancelTimer = useCallback((connectorId: string) => {
    const t = timers.current.get(connectorId);
    if (t !== undefined) clearTimeout(t);
    timers.current.delete(connectorId);
  }, []);

  const remove = useCallback(
    (connectorId: string) => {
      cancelTimer(connectorId);
      update((prev) => {
        if (!(connectorId in prev)) return prev;
        const next = { ...prev };
        delete next[connectorId];
        return next;
      });
    },
    [cancelTimer, update],
  );

  const removeLater = useCallback(
    (connectorId: string, ms: number) => {
      cancelTimer(connectorId);
      timers.current.set(
        connectorId,
        setTimeout(() => {
          timers.current.delete(connectorId);
          remove(connectorId);
        }, ms),
      );
    },
    [cancelTimer, remove],
  );

  useEffect(() => {
    if (!socket || !projectId) return;

    // Subscribe to the project room (server joins on subscribe:project).
    // #642 — re-join on reconnect; the server drops rooms with the old session.
    const release = keepSubscribed(socket, projectJoin(socket, projectId));

    const onProgress = (data: ConnectorProgress) => {
      const { connectorId } = data;
      // Handle error status — clear progress and let UI show error toast
      if (data.status === "error") {
        remove(connectorId);
        onSettledRef.current?.(connectorId);
        return;
      }
      if (!isDeterminate(data)) {
        // #762 — a count-less sub-step (the metadata fetch inside a Deep
        // Ingest) never replaces a stepped run's row; on its own it shows
        // briefly and clears, since no terminal event follows it.
        const current = mapRef.current[connectorId];
        if (current && isDeterminate(current)) return;
        update((prev) => ({ ...prev, [connectorId]: data }));
        removeLater(connectorId, INDETERMINATE_CLEAR_MS);
        return;
      }
      cancelTimer(connectorId);
      update((prev) => ({ ...prev, [connectorId]: data }));
      if (data.current != null && data.current >= data.total!) {
        onSettledRef.current?.(connectorId);
        removeLater(connectorId, COMPLETED_CLEAR_MS);
      }
    };

    socket.on("connector:progress" as never, onProgress as never);
    return () => {
      release();
      socket.off("connector:progress" as never, onProgress as never);
    };
  }, [socket, projectId, remove, removeLater, cancelTimer, update]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const clearProgress = remove;

  return { progressMap, clearProgress };
}

/**
 * Listens for connector discovery events in a project room.
 * Shows a sonner toast with the discovery result.
 */
export function useConnectorDiscovery(projectId: string, onDiscovery?: () => void) {
  const socket = useSocket();
  const callbackRef = useRef(onDiscovery);
  callbackRef.current = onDiscovery;

  useEffect(() => {
    if (!socket || !projectId) return;

    // #642 — re-join on reconnect; the server drops rooms with the old session.
    // #646 — a discovery sent during the gap is not toasted after the fact, but
    // the caller's refresh runs so the suggestions it would have shown appear.
    const release = keepSubscribed(socket, projectJoin(socket, projectId), () =>
      callbackRef.current?.(),
    );

    const onEvent = (data: ConnectorDiscovery) => {
      toast.info(
        `${data.connectionsFound} database connection${data.connectionsFound > 1 ? "s" : ""} discovered in ${data.repoLabel}`,
        {
          description: "Review suggested connectors in the Connections tab.",
          action: {
            label: "View",
            onClick: () => callbackRef.current?.(),
          },
        },
      );
      callbackRef.current?.();
    };

    socket.on("connector:discovery" as never, onEvent as never);
    return () => {
      release();
      socket.off("connector:discovery" as never, onEvent as never);
    };
  }, [socket, projectId]);
}
