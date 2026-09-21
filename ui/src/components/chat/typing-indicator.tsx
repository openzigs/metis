"use client";

/**
 * Epic #475 (Phase 4, #487) — discussion typing indicator.
 *
 * Listens for the Phase 2 `typing:update` socket event (broadcast to OTHER room
 * members only — the server never echoes the sender) and renders an animated
 * "X is typing…" line. State is purely ephemeral. A per-user inactivity timeout
 * clears a stale "typing" if a `typing:stop` (isTyping:false) is missed — e.g.
 * the peer's tab closed — so the indicator never sticks.
 */
import { useEffect, useRef, useState } from "react";
import { useSocket } from "@/lib/socket-client";

interface TypingUpdate {
  threadId: string;
  userId: string;
  username: string;
  isTyping: boolean;
  ts: number;
}

export interface TypingIndicatorProps {
  threadId: string;
  /** Current user id — used to never render our own typing (defensive). */
  currentUserId?: string;
  /** How long a "typing" persists without a refresh before auto-clearing. */
  staleAfterMs?: number;
}

/** Render the "… is typing" text for a set of usernames. */
export function typingLabel(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing…`;
}

export function TypingIndicator({
  threadId,
  currentUserId,
  staleAfterMs = 6000,
}: TypingIndicatorProps) {
  const socket = useSocket();
  const [typers, setTypers] = useState<Map<string, string>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!socket) return;
    const timerMap = timers.current;

    function clearTimer(userId: string) {
      const t = timerMap.get(userId);
      if (t) {
        clearTimeout(t);
        timerMap.delete(userId);
      }
    }
    function remove(userId: string) {
      clearTimer(userId);
      setTypers((prev) => {
        if (!prev.has(userId)) return prev;
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
    }

    function onTyping(evt: TypingUpdate) {
      if (evt.threadId !== threadId) return;
      // Defensive: never render our own typing even if the server echoed it.
      if (currentUserId && evt.userId === currentUserId) return;
      if (!evt.isTyping) {
        remove(evt.userId);
        return;
      }
      setTypers((prev) => {
        const next = new Map(prev);
        next.set(evt.userId, evt.username);
        return next;
      });
      // (Re)arm the stale-clear timer for this user.
      clearTimer(evt.userId);
      timerMap.set(
        evt.userId,
        setTimeout(() => remove(evt.userId), staleAfterMs),
      );
    }

    socket.on("typing:update", onTyping);
    return () => {
      socket.off("typing:update", onTyping);
      for (const t of timerMap.values()) clearTimeout(t);
      timerMap.clear();
    };
  }, [socket, threadId, currentUserId, staleAfterMs]);

  const names = Array.from(typers.values());
  if (names.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
      aria-live="polite"
      data-testid="typing-indicator"
    >
      <span className="flex gap-0.5" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
      </span>
      <span>{typingLabel(names)}</span>
    </div>
  );
}
