"use client";

/**
 * Epic #475 (Phase 4, #486) — multi-analyst discussion thread view.
 *
 * Forked from the single-user chat surface (`app/(authed)/chat/page.tsx`) and
 * adapted for a shared, realtime room:
 *  - Loads history from `GET /threads/:id/messages`.
 *  - Subscribes to the `thread:{id}` socket room and merges live `message:new`
 *    (human + AI) and `message:stream` (AI token) events.
 *  - Posts human messages optimistically, reconciling with the server echo.
 *  - When a posted message mentions `@AI`, triggers `POST .../ai-respond` and
 *    streams the reply over SSE (the same reply also fans out to OTHER members
 *    via the room — we de-dupe by message id).
 *
 * Member-only access is enforced server-side (REST 403/404 + socket
 * `auth:error`); this view surfaces those as an error state rather than gating
 * client-side, keeping the UI honest with the server gate.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSocket } from "@/lib/socket-client";
import {
  listMessages,
  postMessage,
  streamAiReply,
  mentionsAi,
  type DiscussionMessage,
} from "@/lib/discussions-api";
import {
  DiscussionMessageList,
  type DiscussionListMessage,
} from "@/components/chat/discussion-message-list";
import { DiscussionComposer } from "@/components/chat/discussion-composer";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";
import { PromoteToRequirementDialog } from "@/components/chat/promote-to-requirement-dialog";
import { ThreadSettingsPanel } from "@/components/chat/thread-settings-panel";
import { Button } from "@/components/ui/button";
import { PausableLiveRegion } from "@/components/a11y/pausable-live-region";

interface DiscussionMessageNewEvent {
  threadId: string;
  message: DiscussionMessage;
  ts: number;
}
interface DiscussionMessageStreamEvent {
  threadId: string;
  messageId?: string;
  delta: string;
  done: boolean;
  ts: number;
}

export interface DiscussionThreadViewProps {
  threadId: string;
  /** Current user id — drives self-attribution and optimistic author labels. */
  currentUserId?: string;
  /** The thread's AI mode; decides whether an @AI mention triggers a reply. */
  aiResponseMode?: "off" | "on_mention" | "auto";
  /**
   * Project id — required to enable the member-only promote-to-requirement
   * action (#488); when omitted, the promote action is hidden.
   */
  projectId?: string;
  /**
   * Whether the current viewer is a thread member. Gates the promote action +
   * settings (server independently enforces this; the UI just hides affordances
   * the viewer cannot use). Defaults to `true` since non-members can't open the
   * thread at all (the REST/socket layer 403s/404s them first).
   */
  isMember?: boolean;
  /** Optional header slot (presence avatars, settings button — #487/#488). */
  header?: React.ReactNode;
}

/** Merge a message into the list by id (last write wins), preserving order. */
function upsert(
  list: DiscussionListMessage[],
  msg: DiscussionListMessage,
): DiscussionListMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...list, msg];
  const next = [...list];
  next[idx] = { ...next[idx], ...msg };
  return next;
}

export function DiscussionThreadView({
  threadId,
  currentUserId,
  aiResponseMode = "on_mention",
  projectId,
  isMember = true,
  header,
}: DiscussionThreadViewProps) {
  const socket = useSocket();
  const [messages, setMessages] = useState<DiscussionListMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<DiscussionListMessage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState(aiResponseMode);
  const abortRef = useRef<AbortController | null>(null);

  // The promote action is member-only AND needs a project to link the created
  // requirement back to. Both gates are honest with the server-side check.
  const canPromote = isMember && !!projectId;

  // ---- 1. Load history -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const history = await listMessages(threadId, { limit: 100 });
        if (!cancelled) setMessages(history);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || "Failed to load discussion");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // ---- 2. Subscribe to the realtime room -----------------------------------
  useEffect(() => {
    if (!socket) return;
    socket.emit("subscribe:thread", { threadId });

    function onNew(evt: DiscussionMessageNewEvent) {
      if (evt.threadId !== threadId) return;
      setMessages((prev) => {
        // When the authoritative AI message:new arrives, drop any local SSE
        // placeholder (`ai-local-*`) the requester was streaming into — the
        // server row (real id) replaces it, so we never render a duplicate.
        const base =
          evt.message.authorKind === "ai"
            ? prev.filter((m) => !m.id.startsWith("ai-local-"))
            : prev;
        return upsert(base, { ...evt.message, streaming: false });
      });
    }
    function onStream(evt: DiscussionMessageStreamEvent) {
      if (evt.threadId !== threadId || !evt.messageId) return;
      const id = evt.messageId;
      setMessages((prev) => {
        const existing = prev.find((m) => m.id === id);
        if (!existing) {
          // First chunk for a not-yet-seen AI message: create a placeholder.
          return upsert(prev, {
            id,
            threadId,
            authorKind: "ai",
            authorUserId: null,
            aiProvider: null,
            aiModel: null,
            aiSessionId: null,
            body: evt.delta,
            createdAt: new Date().toISOString(),
            editedAt: null,
            streaming: !evt.done,
          });
        }
        return upsert(prev, {
          ...existing,
          body: evt.done ? existing.body : existing.body + evt.delta,
          streaming: !evt.done,
        });
      });
    }

    socket.on("message:new", onNew);
    socket.on("message:stream", onStream);
    return () => {
      socket.emit("unsubscribe:thread", { threadId });
      socket.off("message:new", onNew);
      socket.off("message:stream", onStream);
    };
  }, [socket, threadId]);

  // ---- 3. Drive an AI reply over SSE for the requester ---------------------
  const triggerAiReply = useCallback(
    async (triggerMessageId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      // Local placeholder we stream into. The authoritative server row arrives
      // separately as a room `message:new` (real id), which `onNew` swaps in for
      // this `ai-local-*` placeholder — so we never need the server id here.
      const localId = `ai-local-${crypto.randomUUID()}`;
      const patch = (fn: (m: DiscussionListMessage) => DiscussionListMessage) =>
        setMessages((prev) => {
          const target = prev.find((m) => m.id === localId);
          if (!target) return prev;
          return upsert(prev, fn(target));
        });

      setMessages((prev) =>
        upsert(prev, {
          id: localId,
          threadId,
          authorKind: "ai",
          authorUserId: null,
          aiProvider: null,
          aiModel: null,
          aiSessionId: null,
          body: "",
          createdAt: new Date().toISOString(),
          editedAt: null,
          streaming: true,
        }),
      );
      try {
        for await (const ev of streamAiReply(threadId, triggerMessageId, controller.signal)) {
          if (ev.type === "delta") {
            patch((t) => ({ ...t, body: t.body + ev.content, streaming: true }));
          } else if (ev.type === "error") {
            patch((t) => ({ ...t, body: ev.message, isError: true, streaming: false }));
            toast.error(ev.message);
          } else if (ev.type === "done") {
            patch((t) => ({ ...t, streaming: false }));
          }
        }
      } catch (err) {
        const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
        if (!aborted) {
          const message = (err as Error).message || "AI reply failed";
          patch((t) => ({ ...t, body: message, isError: true, streaming: false }));
          toast.error(message);
        }
      } finally {
        abortRef.current = null;
      }
    },
    [threadId],
  );

  // ---- 4. Post a human message (optimistic) --------------------------------
  const handleSend = useCallback(
    async (body: string) => {
      setSending(true);
      const optimisticId = `local-${crypto.randomUUID()}`;
      setMessages((prev) =>
        upsert(prev, {
          id: optimisticId,
          threadId,
          authorKind: "human",
          authorUserId: currentUserId ?? null,
          aiProvider: null,
          aiModel: null,
          aiSessionId: null,
          body,
          createdAt: new Date().toISOString(),
          editedAt: null,
          authorName: "You",
        }),
      );
      try {
        const saved = await postMessage(threadId, body);
        // Reconcile: replace the optimistic row with the server echo (real id).
        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== optimisticId);
          return upsert(withoutOptimistic, { ...saved, authorName: "You" });
        });
        // Trigger the AI reply when the mode would react to this message. We
        // only spend the round-trip when an @AI mention is present in
        // on_mention mode; in `auto` the server decides, so always ask.
        const wantsAi = mode === "auto" || (mode === "on_mention" && mentionsAi(body));
        if (wantsAi) void triggerAiReply(saved.id);
      } catch (err) {
        // Roll back the optimistic message and surface the failure.
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        toast.error((err as Error).message || "Failed to send message");
      } finally {
        setSending(false);
      }
    },
    [threadId, currentUserId, mode, triggerAiReply],
  );

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">{header}</div>
        {/* #487 — live presence avatars for everyone viewing this thread.
            PresenceAvatars joins `presence:discussion:{discussionId}` itself. */}
        <PresenceAvatars artifactType="discussion" artifactId={threadId} />
        {isMember ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((s) => !s)}
            data-testid="thread-settings-toggle"
          >
            Settings
          </Button>
        ) : null}
      </div>
      {isMember && showSettings ? (
        <div className="rounded-md border border-border p-4">
          {/* #488 — aiResponseMode segmented control + optional anchor. */}
          <ThreadSettingsPanel threadId={threadId} aiResponseMode={mode} onModeChange={setMode} />
        </div>
      ) : null}
      {/* #662 — SC 2.2.2 Pause, Stop, Hide. The thread auto-updates live from
          the socket (new messages + streamed AI replies), so expose a
          keyboard-operable pause control that freezes the transcript and
          silences announcements once there is content to freeze. */}
      <PausableLiveRegion
        label="Discussion thread"
        role="log"
        testId="discussion-log"
        active={messages.length > 0}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border p-4"
      >
        <DiscussionMessageList
          messages={messages}
          loading={loading}
          error={error}
          onPromote={canPromote ? setPromoteTarget : undefined}
        />
      </PausableLiveRegion>
      {canPromote && promoteTarget ? (
        <PromoteToRequirementDialog
          open={!!promoteTarget}
          onOpenChange={(o) => {
            if (!o) setPromoteTarget(null);
          }}
          threadId={threadId}
          messageId={promoteTarget.id}
          projectId={projectId!}
          messageBody={promoteTarget.body}
        />
      ) : null}
      <DiscussionComposer
        onSubmit={handleSend}
        threadId={threadId}
        busy={sending}
        disabled={!!error}
      >
        {/* #487 — typing indicator for OTHER members, above the composer. */}
        <TypingIndicator threadId={threadId} currentUserId={currentUserId} />
      </DiscussionComposer>
    </div>
  );
}
