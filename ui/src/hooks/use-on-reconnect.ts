"use client";

/**
 * #646 — run `reconcile` on every reconnect of the shared socket (not the
 * initial connect), so a view re-reads state an event may have carried while
 * the socket was down. See `onReconnect` in `socket-subscription.ts` for the
 * rules. The latest `reconcile` is held in a ref, so a fresh closure on every
 * render does not re-register the listener.
 */
import { useEffect, useRef } from "react";
import { useSocket } from "@/lib/socket-client";
import { onReconnect } from "@/lib/socket-subscription";

export function useOnReconnect(reconcile: () => void): void {
  const socket = useSocket();
  const reconcileRef = useRef(reconcile);
  useEffect(() => {
    reconcileRef.current = reconcile;
  });
  useEffect(() => {
    if (!socket) return;
    return onReconnect(socket, () => reconcileRef.current());
  }, [socket]);
}
