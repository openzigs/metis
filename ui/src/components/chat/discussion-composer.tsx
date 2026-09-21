"use client";

/**
 * Epic #475 (Phase 4, #486/#487) — discussion composer.
 *
 * Forked from the single-user chat composer, adapted for the multi-analyst
 * surface. #487 swaps the plain textarea for the reused `MentionInput` so typing
 * `@` opens member autocomplete WITH a synthetic `@AI` entry (mentioning `@AI`
 * is what triggers an AI reply in `on_mention` mode), and emits Phase 2
 * `typing:start` / `typing:stop` socket events (debounced) so other members see
 * a live typing indicator.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MentionInput } from "@/components/comments/MentionInput";
import { useSocket } from "@/lib/socket-client";

/** The synthetic `@AI` participant injected into the mention autocomplete. */
export const AI_MENTION_SUGGESTION = {
  id: "__ai__",
  username: "AI",
  displayName: "AI assistant",
};

export interface DiscussionComposerProps {
  onSubmit: (body: string) => void | Promise<void>;
  /** Thread id — drives the `typing:*` socket events. */
  threadId?: string;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  /** Optional slot rendered above the input (e.g. a typing indicator). */
  children?: ReactNode;
  /** Controlled-value seam (parent owns the value). */
  value?: string;
  onChange?: (value: string) => void;
}

/** Debounce window for collapsing keystrokes into typing:start / stop. */
const TYPING_STOP_MS = 2500;

export function DiscussionComposer({
  onSubmit,
  threadId,
  disabled,
  busy,
  placeholder = "Message the team… mention @AI to ask the assistant",
  children,
  value,
  onChange,
}: DiscussionComposerProps) {
  const socket = useSocket();
  const [internal, setInternal] = useState("");
  const controlled = value !== undefined;
  const text = controlled ? value : internal;

  const typingActive = useRef(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emitTyping = useCallback(
    (isTyping: boolean) => {
      if (!socket || !threadId) return;
      if (isTyping === typingActive.current) return;
      typingActive.current = isTyping;
      socket.emit(isTyping ? "typing:start" : "typing:stop", { threadId });
    },
    [socket, threadId],
  );

  const setText = useCallback(
    (next: string) => {
      if (controlled) onChange?.(next);
      else setInternal(next);
      // Drive typing indicators: any non-empty edit means "typing"; a debounce
      // emits "stop" after a pause; clearing the box stops immediately.
      if (next.trim().length > 0) {
        emitTyping(true);
        if (stopTimer.current) clearTimeout(stopTimer.current);
        stopTimer.current = setTimeout(() => emitTyping(false), TYPING_STOP_MS);
      } else {
        if (stopTimer.current) clearTimeout(stopTimer.current);
        emitTyping(false);
      }
    },
    [controlled, onChange, emitTyping],
  );

  // Stop typing + clear the debounce on unmount.
  useEffect(
    () => () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      emitTyping(false);
    },
    [emitTyping],
  );

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body || disabled || busy) return;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    emitTyping(false);
    setText("");
    await onSubmit(body);
  }, [text, disabled, busy, emitTyping, setText, onSubmit]);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {children}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <MentionInput
            value={text}
            onChange={setText}
            placeholder={placeholder}
            disabled={disabled}
            ariaLabel="Message"
            extraSuggestions={[AI_MENTION_SUGGESTION]}
            className="resize-none"
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline. MentionInput defers
              // its key handler to us only when the autocomplete is closed.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <Button type="submit" disabled={disabled || busy || !text.trim()}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
