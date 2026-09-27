"use client";

/**
 * Phase 4 chat workspace.
 *
 * Minimal but functional: list/create sessions, send messages, stream the
 * assistant's reply via SSE, and show each tool call as it happens (#143) —
 * a call the session's policy says needs approval waits for Approve / Deny
 * here (#142). The approval gate itself is server-side; this page only sends
 * the owner's answer.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PausableLiveRegion } from "@/components/a11y/pausable-live-region";
import {
  type AISession,
  type DisplayTurn,
  type SessionScope,
  type StreamEvent,
  createSessionWithScope,
  listSessionAgents,
  sessionAgentInput,
  forkChatSession,
  getTranscriptSince,
  lastHeldOrdinal,
  mergeTranscriptDelta,
  loadActiveSessionId,
  resumeChatSession,
  storeActiveSessionId,
  streamChat,
} from "@/lib/ai-client";
import { AgentPicker, loadStoredAgentKey, storeAgentKey } from "@/components/chat/agent-picker";
import { LoadedSkillsPanel } from "@/components/chat/loaded-skills-panel";
import { ProjectScopeSelector, useProjectScope } from "@/components/chat/project-scope-selector";
import { ScopeDegradationNotice } from "@/components/chat/scope-degradation-notice";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { sanitizeAssistantText } from "@/lib/sanitize-assistant-text";
import { recentTracker } from "@/lib/recent-tracker";
import { ToolActivityList, TranscriptToolCalls } from "@/components/chat/tool-activity";
import { useToolApprovals } from "@/hooks/use-tool-approvals";

/**
 * #136 — a transcript row as rendered. Rows that came from the server carry
 * their `ordinal` (what "fork from here" sends back); the two optimistic rows of
 * a turn in flight have none until the transcript is re-read after the turn.
 */
interface DisplayMessage extends Partial<Omit<DisplayTurn, "role" | "content">> {
  id: string;
  role: DisplayTurn["role"];
  content: string;
  isError?: boolean;
  /**
   * #1366 — the turn ended before the model finished. The partial text is kept
   * (it is usually still useful) but must be labelled, because silently showing
   * a truncated answer as if it were complete is worse than showing nothing.
   */
  incomplete?: string;
}

/**
 * Starter prompts shown on the empty-state canvas. Clicking one seeds the
 * input so the user can review/edit before sending — a blank "Ask anything…"
 * box gives no guidance, so we offer a few representative actions.
 */
const SUGGESTED_PROMPTS: { title: string; prompt: string }[] = [
  { title: "Summarize a project", prompt: "Give me a high-level summary of this project." },
  { title: "Find recent changes", prompt: "What are the most recent changes in this codebase?" },
  {
    title: "Explain a codebase area",
    prompt: "Explain how the authentication flow works in this codebase.",
  },
  { title: "Draft a plan", prompt: "Help me draft an implementation plan for a new feature." },
];

function fromServer(rows: DisplayTurn[]): DisplayMessage[] {
  return rows.map((m) => ({ ...m, id: `o${m.ordinal}` }));
}

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? undefined;
  // #1367 — /sessions "Resume" navigates here with the session to rehydrate.
  const resumeSessionId = searchParams.get("sessionId") ?? undefined;
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const { scope, setScope, hydrated: scopeHydrated } = useProjectScope();
  const [session, setSession] = useState<AISession | null>(null);
  // #607 — scope metadata from session-create; drives the degradation banner
  // when the applied scope differs from the user's selection.
  const [sessionScope, setSessionScope] = useState<SessionScope | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #138 — shown when older turns were summarised to fit the model's context.
  const [compactionNote, setCompactionNote] = useState<string | null>(null);
  // #204 — shown while the turn waits behind another local-model generation.
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  // #149 — set when the resumed session is read-only (its provider was removed).
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  // #142/#143 — the tool calls of the turn in flight (cleared when the next
  // starts) and the owner's Approve / Deny; shared with the Workbench.
  const toolApprovals = useToolApprovals(session?.id ?? null, setError);
  const resetToolActivity = toolApprovals.reset;
  // The session on screen now — a transcript read that lands after the user
  // switched sessions must not overwrite the new one.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
  }, [session]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Only the FIRST run of the session effect may resume. A later run means the
  // user changed agent or scope, which must start a fresh session.
  const mountedOnceRef = useRef(false);
  // #1368 — a `?projectId=` the server rejected as stale. Re-sending it would
  // reproduce the degraded session forever, leaving the composer permanently
  // blocked with no way out; once rejected we fall back to the scope picker.
  const [rejectedProjectId, setRejectedProjectId] = useState<string | null>(null);
  const effectiveProjectId = projectId && projectId !== rejectedProjectId ? projectId : undefined;

  // Hydrate the persisted agent choice once on mount. Set BEFORE the
  // session-create effect so the first session is created under the right
  // persona instead of "default-then-flip".
  const [agentHydrated, setAgentHydrated] = useState(false);
  useEffect(() => {
    setAgentKey(loadStoredAgentKey());
    setAgentHydrated(true);
  }, []);

  // #236 — the one project a new session would be scoped to (a URL project,
  // or a single project picked in the scope selector): its custom agents can
  // be the session's agent.
  const pickerProjectId =
    effectiveProjectId ??
    (scope.mode === "selected" && scope.projectIds.length === 1 ? scope.projectIds[0] : null);

  // #236 — a saved custom agent belongs to the project it was picked in. When
  // the session cannot bind it here, the chat falls back to the default agent,
  // the stored choice is cleared, and the user is told once.
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  // Clearing the choice changes `agentKey`, which would otherwise re-run the
  // session effect and create a SECOND session for a chat that already has one.
  const skipAgentRecreateRef = useRef(false);

  async function pickSessionAgent(
    selection: string | null,
  ): Promise<{ selection: string | null; dropped: string | null }> {
    if (!selection?.startsWith("custom:") || !pickerProjectId) {
      return { selection, dropped: null };
    }
    // A listing failure (a stale project reads 404) is not a verdict: send the
    // choice and let the server's refusal trigger the one retry.
    const available = await listSessionAgents(pickerProjectId).catch(() => null);
    if (available && !available.some((a) => a.ref === selection)) {
      return { selection: null, dropped: selection };
    }
    return { selection, dropped: null };
  }

  function fallBackToDefaultAgent() {
    storeAgentKey(null);
    setAgentNotice(
      "The agent you picked earlier is not available in this project, so this chat uses the default agent.",
    );
    skipAgentRecreateRef.current = true;
    setAgentKey(null);
  }

  // Serialize scope for stable deps comparison (avoids infinite re-renders).
  const scopeKey = scope.mode === "all" ? "all" : `selected:${scope.projectIds.sort().join(",")}`;

  useEffect(() => {
    // #1367 — agent and scope both arrive from localStorage one tick after
    // mount. Running before they land burned the one allowed resume on a
    // throwaway default-valued pass, so the real pass created a new session and
    // overwrote the stored id: a reload of bare `/chat` lost the conversation.
    if (!agentHydrated || !scopeHydrated) return;
    // #236 — this run was caused by clearing an unusable agent choice after
    // the session had already been created with the default agent.
    if (skipAgentRecreateRef.current) {
      skipAgentRecreateRef.current = false;
      return;
    }
    let cancelled = false;
    abortRef.current?.abort();
    setSession(null);
    setSessionScope(null);
    setMessages([]);
    // A compaction note belongs to the session it happened in.
    setCompactionNote(null);
    setReadOnlyReason(null);
    resetToolActivity();
    const firstRun = !mountedOnceRef.current;
    mountedOnceRef.current = true;
    void (async () => {
      try {
        // #1367 — resume before creating. `main` always created a new session,
        // so a reload silently destroyed the conversation.
        const restoreId = resumeSessionId ?? (firstRun ? loadActiveSessionId() : null);
        if (restoreId) {
          const restored = await resumeChatSession(restoreId);
          if (restored && !cancelled) {
            setSession(restored.session);
            setMessages(fromServer(restored.messages));
            setReadOnlyReason(restored.readOnlyReason ?? null);
            storeActiveSessionId(restored.session.id);
            return;
          }
        }
        const agent = await pickSessionAgent(agentKey);
        if (cancelled) return;
        const sessionOpts: Parameters<typeof createSessionWithScope>[0] = {
          title: "New Chat",
          ...sessionAgentInput(agent.selection, pickerProjectId),
        };
        // If a single projectId is in the URL, use it. Otherwise, pass
        // the scope selector's projectIds for cross-project mode.
        if (effectiveProjectId) {
          sessionOpts.projectId = effectiveProjectId;
        } else if (scope.mode === "selected" && scope.projectIds.length > 0) {
          sessionOpts.projectIds = scope.projectIds;
        }
        const created = await createSessionWithScope(sessionOpts);
        if (!cancelled) {
          setSession(created.session);
          setSessionScope(created.scope);
          storeActiveSessionId(created.session.id);
          if (created.scope?.reason === "stale-project" && effectiveProjectId) {
            setRejectedProjectId(effectiveProjectId);
          }
          if (agent.dropped ?? created.droppedAgentRef) fallBackToDefaultAgent();
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // Re-create the session whenever the user picks a different agent or
    // the projectId query param changes — the AC explicitly calls for
    // "Switching agents starts a new session" because the system prompt +
    // default skills change at session-create.
  }, [
    agentKey,
    pickerProjectId,
    projectId,
    effectiveProjectId,
    scopeKey,
    resumeSessionId,
    agentHydrated,
    scopeHydrated,
    resetToolActivity,
  ]);

  function handleNewChat() {
    abortRef.current?.abort();
    storeActiveSessionId(null);
    setMessages([]);
    setError(null);
    setCompactionNote(null);
    // Per-session UI state is reset here AND in the session-load effect; a
    // read-only notice left over from a resumed session would lock the new one.
    setReadOnlyReason(null);
    setSession(null);
    void (async () => {
      try {
        const agent = await pickSessionAgent(agentKey);
        const created = await createSessionWithScope({
          title: "New Chat",
          ...sessionAgentInput(agent.selection, pickerProjectId),
          ...(effectiveProjectId
            ? { projectId: effectiveProjectId }
            : scope.mode === "selected" && scope.projectIds.length > 0
              ? { projectIds: scope.projectIds }
              : {}),
        });
        setSession(created.session);
        setSessionScope(created.scope);
        storeActiveSessionId(created.session.id);
        if (agent.dropped ?? created.droppedAgentRef) fallBackToDefaultAgent();
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }

  function handleAgentChange(next: string | null) {
    setAgentNotice(null);
    storeAgentKey(next);
    setAgentKey(next);
  }

  // #1368 — a degraded scope means the session is NOT grounded in the project
  // the user picked. `main` let the turn run anyway and disclosed it afterwards,
  // by which point the model had already answered from the wrong corpus. The
  // send is now refused while the notice is on screen, so the user is told
  // BEFORE the turn, not after it.
  const scopeBlocked = Boolean(sessionScope?.degraded);
  // #149 — a read-only session keeps its transcript but refuses new turns.
  const sendBlocked = scopeBlocked || readOnlyReason !== null;

  async function handleSend() {
    if (!session || !input.trim() || streaming || sendBlocked) return;
    const userMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input,
    };
    const assistantMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    setMessages([...messages, userMsg, assistantMsg]);
    resetToolActivity();
    setInput("");
    setStreaming(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // #136 — only the new message goes up; the server holds the history.
      for await (const ev of streamChat(session.id, userMsg.content, controller.signal)) {
        handleEvent(ev, assistantMsg.id);
      }
    } catch (err) {
      // A user-initiated Stop aborts the controller; that surfaces here as an
      // AbortError. Treat it as a clean cancellation — keep the partial reply,
      // don't show an error banner.
      const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
      if (!aborted) setError((err as Error).message);
    } finally {
      setStreaming(false);
      setQueueNote(null);
      abortRef.current = null;
      // #136 — re-render from the server transcript: it is the record, and it
      // carries the ordinals "fork from here" needs. #212 — only what changed:
      // the rows after the last one this page already held (this turn's, and a
      // compaction summary), plus the compaction state of held rows a summary
      // folded. A failed read keeps what is on screen.
      const sessionId = session.id;
      const afterOrdinal = lastHeldOrdinal(messages);
      void getTranscriptSince(sessionId, afterOrdinal)
        .then((delta) => {
          if (sessionIdRef.current !== sessionId) return;
          setMessages((prev) => mergeTranscriptDelta(prev, delta, (m) => fromServer([m])[0]!));
        })
        .catch(() => undefined);
      // #1367 — dashboard "Recent activity" read an empty localStorage store
      // because nothing in chat ever wrote to it. Record the session once a turn
      // has actually happened, so the widget reflects real chat activity.
      recentTracker.touch({
        kind: "session",
        id: session.id,
        label: session.title || "Chat",
        href: `/chat?sessionId=${encodeURIComponent(session.id)}`,
        ...(session.projectId ? { projectId: session.projectId } : {}),
      });
    }
  }

  // #139 — start a new session from this reply, keeping model, agent and skills.
  async function handleFork(ordinal: number) {
    if (!session || forking || streaming) return;
    setForking(true);
    setError(null);
    try {
      const forked = await forkChatSession(session.id, ordinal);
      // The note described the source session's compaction, not the fork's.
      setCompactionNote(null);
      storeActiveSessionId(forked.session.id);
      router.push(`/chat?sessionId=${encodeURIComponent(forked.session.id)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setForking(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleSuggestedPrompt(prompt: string) {
    setInput(prompt);
    inputRef.current?.focus();
  }

  function handleEvent(ev: StreamEvent, assistantMsgId: string) {
    // #204 — anything but a `queue` frame means the model is past the queue.
    if (ev.type !== "queue") setQueueNote(null);
    switch (ev.type) {
      case "queue":
        setQueueNote(
          ev.state === "waiting"
            ? `Waiting for the local model — it is busy with another request${
                ev.position && ev.position > 1 ? ` (${ev.position - 1} ahead of this one)` : ""
              }. This time does not count against the response's time limit.`
            : null,
        );
        break;
      case "delta":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: m.content + ev.content } : m,
          ),
        );
        break;
      case "tool_event":
        toolApprovals.apply(ev);
        break;
      case "tool_call":
        // #713's summary frame; `tool_event` carries the full lifecycle. The
        // old confirm() here decided nothing server-side — approval is #142's.
        break;
      case "error":
        setMessages((prev) => {
          const lastAssistant = [...prev].reverse().find((m) => m.role === "assistant");
          if (!lastAssistant) return prev;
          // #1366 — `main` only rendered the error when the assistant message was
          // EMPTY, so a stream that died mid-answer showed nothing at all next to
          // the truncated text. Partial content is now kept AND labelled.
          if (!lastAssistant.content) {
            return prev.map((m) =>
              m.id === lastAssistant.id ? { ...m, content: ev.message, isError: true } : m,
            );
          }
          return prev.map((m) =>
            m.id === lastAssistant.id ? { ...m, incomplete: ev.message } : m,
          );
        });
        setError(ev.message);
        break;
      case "compaction":
        setCompactionNote(
          `Older messages (${ev.compaction.compactedMessages}) were summarised to fit the model's context. They are still in this conversation's history below.`,
        );
        break;
      case "usage":
      case "done":
        break;
    }
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 p-6">
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Chat</h1>
          <div className="flex items-center gap-3">
            {/* #1368 — the selector is normally hidden when a projectId is in
                the URL, but a stale one degrades the scope and blocks the send;
                without the picker there would be nothing on screen to pick, so
                show it as the escape hatch. */}
            {!effectiveProjectId || scopeBlocked ? (
              <ProjectScopeSelector value={scope} onChange={setScope} disabled={streaming} />
            ) : null}
            <AgentPicker
              value={agentKey}
              onChange={handleAgentChange}
              disabled={streaming}
              projectId={pickerProjectId}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleNewChat}
              disabled={streaming}
              data-testid="chat-new-session"
            >
              New chat
            </Button>
            {session ? (
              <span className="text-sm text-muted-foreground">
                {session.provider} · {session.model}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">starting session…</span>
            )}
          </div>
        </div>
        <ScopeDegradationNotice scope={sessionScope} />
        {agentNotice ? (
          <p role="status" data-testid="chat-agent-fallback-notice" className="text-sm">
            {agentNotice}
          </p>
        ) : null}
        {readOnlyReason ? (
          <div
            role="status"
            data-testid="chat-read-only-notice"
            className="rounded border border-amber-500 p-2 text-sm"
          >
            {readOnlyReason}
          </div>
        ) : null}
        {queueNote ? (
          <p role="status" data-testid="chat-queue-note" className="text-xs text-muted-foreground">
            {queueNote}
          </p>
        ) : null}
        {compactionNote ? (
          <p
            role="status"
            data-testid="chat-compaction-note"
            className="text-xs text-muted-foreground"
          >
            {compactionNote}
          </p>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="rounded border border-destructive p-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}
        {/* #662 — SC 2.2.2 Pause, Stop, Hide. The transcript auto-updates while
            the assistant streams (>5s runs); PausableLiveRegion adds a
            keyboard-operable pause control that freezes updates + silences
            announcements. The control shows only once there is live content. */}
        <PausableLiveRegion
          label="Chat transcript"
          role="log"
          testId="chat-log"
          active={streaming || messages.length > 0}
          className="flex-1 overflow-y-auto rounded-xl border bg-card p-4 text-card-foreground shadow"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
              <div>
                <h2 className="text-lg font-semibold">How can I help you today?</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {session
                    ? "Ask a question, or start from one of these:"
                    : "Starting your session…"}
                </p>
              </div>
              {session ? (
                <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTED_PROMPTS.map((s) => (
                    <button
                      key={s.title}
                      type="button"
                      onClick={() => handleSuggestedPrompt(s.prompt)}
                      className="rounded-lg border border-border bg-card p-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-medium">{s.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{s.prompt}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <ul className="space-y-3">
              {messages.map((m) =>
                m.role === "summary" ? (
                  <li
                    key={m.id}
                    data-testid="chat-summary"
                    className="rounded border border-dashed p-2 text-xs text-muted-foreground"
                  >
                    <strong className="mr-1">Summary of earlier messages</strong>
                    {m.summaryOf
                      ? `(#${m.summaryOf.fromOrdinal}–#${m.summaryOf.toOrdinal}, ${m.summaryOf.messageCount} messages)`
                      : null}
                    {m.summaryOf?.truncated ? (
                      <span data-testid="chat-summary-truncated" className="ml-1 text-destructive">
                        — this summary hit its length limit and may be missing detail; the original
                        messages are kept below.
                      </span>
                    ) : null}
                    <span className="mt-1 block whitespace-pre-wrap">{m.content}</span>
                  </li>
                ) : (
                  <li
                    key={m.id}
                    className={`text-sm ${m.isError ? "text-destructive" : ""} ${m.compacted ? "opacity-60" : ""}`}
                  >
                    <strong className="mr-2 capitalize">{m.role}:</strong>
                    {m.compacted ? (
                      <span
                        className="mr-2 rounded bg-muted px-1 text-[10px] uppercase"
                        title="Summarised for the model; kept here in full"
                      >
                        summarised
                      </span>
                    ) : null}
                    {m.isError ? (
                      <span className="whitespace-pre-wrap">{`⚠ ${m.content}`}</span>
                    ) : m.role === "assistant" && m.content ? (
                      <ChatMarkdown
                        content={sanitizeAssistantText(m.content)}
                        streaming={streaming && m === messages[messages.length - 1]}
                      />
                    ) : (
                      <span className="whitespace-pre-wrap">
                        {m.content || (streaming ? "…" : "")}
                      </span>
                    )}
                    {m.role === "assistant" && m.toolCalls ? (
                      <TranscriptToolCalls calls={m.toolCalls} sessionId={session?.id ?? null} />
                    ) : null}
                    {m.incomplete ? (
                      <p
                        role="status"
                        data-testid="incomplete-answer-notice"
                        className="mt-1 rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
                      >
                        Incomplete answer — {m.incomplete}
                      </p>
                    ) : null}
                    {m.role === "assistant" &&
                    m.ordinal !== undefined &&
                    !streaming &&
                    readOnlyReason === null ? (
                      <button
                        type="button"
                        onClick={() => void handleFork(m.ordinal!)}
                        disabled={forking}
                        data-testid={`chat-fork-${m.ordinal}`}
                        className="mt-1 block text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Fork from here
                      </button>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          )}
        </PausableLiveRegion>
        <ToolActivityList
          sessionId={session?.id ?? null}
          items={toolApprovals.items}
          deciding={toolApprovals.deciding}
          onDecide={(item, decision) => void toolApprovals.decide(item, decision)}
        />
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <Input
            ref={inputRef}
            aria-label="Message"
            placeholder={
              readOnlyReason
                ? "This session is read-only"
                : scopeBlocked
                  ? "Pick one project to continue…"
                  : "Ask anything…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!session || streaming || sendBlocked}
          />
          {streaming ? (
            <Button type="button" variant="destructive" onClick={handleStop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!session || !input.trim() || sendBlocked}>
              Send
            </Button>
          )}
        </form>
      </div>
      <aside className="hidden w-72 shrink-0 lg:block" aria-label="Session skills">
        <LoadedSkillsPanel sessionId={session?.id ?? null} projectId={session?.projectId ?? null} />
      </aside>
    </div>
  );
}
