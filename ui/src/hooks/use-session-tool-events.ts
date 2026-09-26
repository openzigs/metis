"use client";

/**
 * Epic #128 / #143 — tool events for ONE chat session from its socket room.
 *
 * The SSE stream carries the same events while a turn is streaming; the room
 * also reaches a page whose turn went through the non-streaming route, or that
 * reconnected mid-turn. The server admits only the session's owner to the room
 * (#142), and the handler still filters on `sessionId` because the socket is
 * shared across the app.
 */
import { useEffect, useRef } from "react";
import type { AiToolEvent } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { parseToolEvent } from "@/lib/ai-client";

export function useSessionToolEvents(
  sessionId: string | null,
  onEvent: (event: AiToolEvent) => void,
): void {
  const socket = useSocket();
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!socket || !sessionId) return;
    socket.emit("subscribe:session", { sessionId });
    const onToolEvent = (data: unknown) => {
      const ev = parseToolEvent(data);
      if (!ev || ev.sessionId !== sessionId) return;
      handlerRef.current(ev);
    };
    socket.on("ai:tool:event" as never, onToolEvent as never);
    return () => {
      socket.off("ai:tool:event" as never, onToolEvent as never);
      socket.emit("unsubscribe:session", { sessionId });
    };
  }, [socket, sessionId]);
}
