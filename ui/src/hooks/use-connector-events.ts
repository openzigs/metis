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

/**
 * Listens for connector progress events in a project room.
 * Returns a map of connectorId → latest progress.
 */
export function useConnectorProgress(projectId: string) {
  const socket = useSocket();
  const [progressMap, setProgressMap] = useState<Record<string, ConnectorProgress>>({});

  useEffect(() => {
    if (!socket || !projectId) return;

    // Subscribe to the project room (server joins on subscribe:project)
    socket.emit("subscribe:project", { projectId });

    const onProgress = (data: ConnectorProgress) => {
      // Handle error status — clear progress and let UI show error toast
      if (data.status === "error") {
        setProgressMap((prev) => {
          const next = { ...prev };
          delete next[data.connectorId];
          return next;
        });
        return;
      }
      setProgressMap((prev) => ({ ...prev, [data.connectorId]: data }));
      // Clear progress 2s after reaching total (complete)
      if (data.current != null && data.total != null && data.current >= data.total) {
        setTimeout(() => {
          setProgressMap((prev) => {
            const next = { ...prev };
            delete next[data.connectorId];
            return next;
          });
        }, 2000);
      }
    };

    socket.on("connector:progress" as never, onProgress as never);
    return () => {
      socket.off("connector:progress" as never, onProgress as never);
    };
  }, [socket, projectId]);

  const clearProgress = useCallback((connectorId: string) => {
    setProgressMap((prev) => {
      const next = { ...prev };
      delete next[connectorId];
      return next;
    });
  }, []);

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

    socket.emit("subscribe:project", { projectId });

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
      socket.off("connector:discovery" as never, onEvent as never);
    };
  }, [socket, projectId]);
}
