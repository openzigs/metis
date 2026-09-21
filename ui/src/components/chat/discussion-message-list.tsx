"use client";

/**
 * Epic #475 (Phase 4, #486) — discussion message list.
 *
 * Renders a thread's messages with DISTINCT human vs AI attribution: a colored
 * avatar + author label, and (for AI) a badge showing the model id. Message
 * bodies render through the XSS-safe {@link ChatMarkdown} renderer — no raw HTML
 * reaches the DOM. AI messages that are still streaming show a live cursor.
 */
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { cn } from "@/lib/utils";
import type { DiscussionMessage } from "@/lib/discussions-api";

export interface DiscussionListMessage extends DiscussionMessage {
  /** True while this AI message is mid-stream (renders a streaming cursor). */
  streaming?: boolean;
  /** Optional display name for the human author (falls back to the user id). */
  authorName?: string;
  /** Optional error flag — renders the body in the destructive style. */
  isError?: boolean;
}

function avatarColor(seed: string): string {
  const colors = [
    "bg-violet-600",
    "bg-indigo-600",
    "bg-sky-600",
    "bg-emerald-600",
    "bg-amber-600",
    "bg-rose-600",
    "bg-teal-600",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  return colors[Math.abs(hash) % colors.length];
}

function initials(label: string): string {
  return label.slice(0, 2).toUpperCase();
}

/** True for a message that can be promoted: persisted (real server id), not a
 *  streaming placeholder, not an error. Optimistic local rows use a `local-`/
 *  `ai-local-` id prefix and must not be promotable until reconciled. */
export function isPromotable(message: DiscussionListMessage): boolean {
  if (message.streaming || message.isError || !message.body.trim()) return false;
  return !message.id.startsWith("local-") && !message.id.startsWith("ai-local-");
}

/** A single message row — exported for focused tests. */
export function DiscussionMessageItem({
  message,
  onPromote,
}: {
  message: DiscussionListMessage;
  /** Member-only promote action. When omitted, no promote button renders. */
  onPromote?: (message: DiscussionListMessage) => void;
}) {
  const isAi = message.authorKind === "ai";
  const label = isAi ? "AI" : (message.authorName ?? message.authorUserId ?? "Unknown");
  const seed = isAi ? "ai" : (message.authorUserId ?? label);
  const showPromote = !!onPromote && isPromotable(message);

  return (
    <li
      className="group flex gap-3"
      data-author-kind={message.authorKind}
      data-testid="discussion-message"
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white",
          isAi ? "bg-foreground" : avatarColor(seed),
        )}
        aria-hidden
      >
        {isAi ? "AI" : initials(label)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{isAi ? "AI" : label}</span>
          {isAi && message.aiModel ? (
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[0.7rem] font-medium text-muted-foreground"
              data-testid="ai-model-badge"
            >
              {message.aiModel}
            </span>
          ) : null}
          {!isAi ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
              human
            </span>
          ) : null}
          {showPromote ? (
            <button
              type="button"
              onClick={() => onPromote?.(message)}
              className="ml-auto rounded px-1.5 py-0.5 text-[0.7rem] font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              data-testid="promote-action"
            >
              Promote to requirement
            </button>
          ) : null}
        </div>
        <div className={cn("mt-0.5 text-sm", message.isError && "text-destructive")}>
          {message.isError ? (
            <span className="whitespace-pre-wrap">{`⚠ ${message.body}`}</span>
          ) : message.body ? (
            <ChatMarkdown content={message.body} streaming={message.streaming} />
          ) : (
            <span className="whitespace-pre-wrap text-muted-foreground">
              {message.streaming ? "…" : ""}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export interface DiscussionMessageListProps {
  messages: DiscussionListMessage[];
  loading?: boolean;
  error?: string | null;
  /** Member-only promote action threaded down to each row. */
  onPromote?: (message: DiscussionListMessage) => void;
}

export function DiscussionMessageList({
  messages,
  loading,
  error,
  onPromote,
}: DiscussionMessageListProps) {
  if (error) {
    return (
      <div role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading discussion…
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium">No messages yet</p>
        <p className="text-xs text-muted-foreground">
          Start the discussion — mention <span className="font-mono">@AI</span> to bring the
          assistant in.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-4" aria-label="Discussion messages">
      {messages.map((m) => (
        <DiscussionMessageItem key={m.id} message={m} onPromote={onPromote} />
      ))}
    </ul>
  );
}
