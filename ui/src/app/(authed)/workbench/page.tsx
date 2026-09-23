/**
 * Phase 12 — Workbench page (issue #84).
 *
 * Three-pane layout: documents/knowledge tree (left), chat (center),
 * tasks + recent (right). Layout widths persist per browser via
 * `workbench-storage.ts`. Selecting a tree item attaches it to the chat
 * context as a context chip; the recent panel surfaces the user's
 * last-used sessions and analyses.
 *
 * The chat surface here is intentionally a thin reuse of the Phase 4
 * chat client — the workbench is a container, not a re-implementation.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { projectsApi, documentsApi, type DocumentRow, type Project } from "@/lib/projects-api";
import { formatDocLabel } from "@/lib/doc-label";
import { formatSourceLabel } from "@/lib/format-source-label";
import {
  type AISession,
  type ChatMessage,
  type StreamEvent,
  createSession,
  streamChat,
} from "@/lib/ai-client";
import { analysisApi } from "@/lib/analysis-api";
import { tasksApi } from "@/lib/scheduler-api";
import { loadLayout, saveLayout, resetLayout, type WorkbenchLayout } from "@/lib/workbench-storage";
import { recentTracker } from "@/lib/recent-tracker";
import { LoadedSkillsPanel } from "@/components/chat/loaded-skills-panel";
import { AgentPicker } from "@/components/chat/agent-picker";
import { SlashCommandPopover } from "@/components/chat/slash-command-popover";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { consumeRunPayload } from "@/lib/templates";
import { phase12QueryKeys } from "@/lib/phase12-query-keys";

interface DisplayMessage extends ChatMessage {
  id: string;
  isError?: boolean;
}

export default function WorkbenchPage() {
  const [layout, setLayout] = useState<WorkbenchLayout>(() => loadLayout());
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [session, setSession] = useState<AISession | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Persist layout whenever it changes.
  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  // Hand-off from Library: seed input from a "run template" payload.
  useEffect(() => {
    const payload = consumeRunPayload();
    if (payload) setInput(payload.prompt);
  }, []);

  // Load project list once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await projectsApi.list({ limit: 50 });
        if (cancelled) return;
        setProjects(list.items);
        if (list.items[0]) setActiveProjectId(list.items[0].id);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Documents for the left panel.
  const documents = useQuery({
    queryKey: ["workbench", "documents", activeProjectId ?? "_none"],
    queryFn: () => documentsApi.list(activeProjectId ?? "", { limit: 50 }),
    enabled: Boolean(activeProjectId),
  });

  // Recent analyses (server-side).
  const analyses = useQuery({
    queryKey: phase12QueryKeys.recentAnalyses(activeProjectId),
    queryFn: () => analysisApi.listForProject(activeProjectId ?? ""),
    enabled: Boolean(activeProjectId),
  });

  // Recent tasks (cross-project).
  const tasks = useQuery({
    queryKey: ["workbench", "tasks", activeProjectId ?? "_global"],
    queryFn: () =>
      tasksApi.list({ ...(activeProjectId ? { projectId: activeProjectId } : {}), take: 10 }),
  });

  // Open a session whenever the active project or agent changes.
  useEffect(() => {
    let cancelled = false;
    abortRef.current?.abort();
    setSession(null);
    setMessages([]);
    void (async () => {
      try {
        const s = await createSession({
          title: "Workbench",
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
          ...(layout.agentKey ? { agentKey: layout.agentKey } : {}),
        });
        if (cancelled) return;
        setSession(s);
        recentTracker.touch({
          kind: "session",
          id: s.id,
          label: s.title,
          href: `/chat?session=${encodeURIComponent(s.id)}`,
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
        });
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [activeProjectId, layout.agentKey]);

  const contextDocs = useMemo<DocumentRow[]>(() => {
    const all = documents.data?.items ?? [];
    return all.filter((d) => layout.contextIds.includes(d.id));
  }, [documents.data, layout.contextIds]);

  function attachToContext(docId: string) {
    setLayout((prev) =>
      prev.contextIds.includes(docId) ? prev : { ...prev, contextIds: [...prev.contextIds, docId] },
    );
  }

  function detachFromContext(docId: string) {
    setLayout((prev) => ({
      ...prev,
      contextIds: prev.contextIds.filter((id) => id !== docId),
    }));
  }

  function clearContext() {
    setLayout((prev) => ({ ...prev, contextIds: [] }));
  }

  async function handleSend() {
    if (!session || !input.trim() || streaming) return;
    const composed = composeWithContext(input, contextDocs);
    const userMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: composed,
    };
    const assistantMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    const next = [...messages, userMsg, assistantMsg];
    setMessages(next);
    setInput("");
    setStreaming(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const wireMessages: ChatMessage[] = next
        .filter((m) => m.id !== assistantMsg.id)
        .map(({ role, content, name }) => ({ role, content, ...(name ? { name } : {}) }));
      for await (const ev of streamChat(session.id, wireMessages, controller.signal)) {
        handleStream(ev, assistantMsg.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleStream(ev: StreamEvent, assistantMsgId: string) {
    if (ev.type === "delta") {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, content: m.content + ev.content } : m)),
      );
    } else if (ev.type === "tool_call") {
      if (ev.risk !== "low") {
        const ok = window.confirm(
          `Allow ${ev.risk}-risk tool "${ev.name}"?\n\nArgs: ${JSON.stringify(ev.arguments)}`,
        );
        if (!ok) abortRef.current?.abort();
      }
    } else if (ev.type === "error") {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId && !m.content ? { ...m, content: ev.message, isError: true } : m,
        ),
      );
      setError(ev.message);
    }
  }

  const leftPct = layout.leftPct;
  const rightPct = layout.rightPct;
  const gridStyle: CSSProperties = {
    ["--wb-left" as string]: `${leftPct}%`,
    ["--wb-right" as string]: `${rightPct}%`,
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3" data-testid="workbench-root">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Workbench</h1>
          <p className="text-sm text-muted-foreground">
            Per-project command center — tree, chat, and quick actions in one surface.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Project:</span>
            <select
              data-testid="workbench-project-picker"
              aria-label="Active project"
              className="rounded border bg-background px-2 py-1 text-sm"
              value={activeProjectId ?? ""}
              onChange={(e) => setActiveProjectId(e.target.value || null)}
            >
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              resetLayout();
              setLayout(loadLayout());
            }}
            data-testid="workbench-reset-layout"
          >
            Reset layout
          </Button>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded border border-destructive p-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div
        className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[var(--wb-left)_1fr_var(--wb-right)]"
        style={gridStyle}
      >
        {/* LEFT — documents tree */}
        <Card className="flex min-h-0 flex-col p-3" data-testid="workbench-left-panel">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Documents</h2>
            <PanelResizer
              ariaLabel="Resize left panel"
              value={layout.leftPct}
              onChange={(v) => setLayout((prev) => ({ ...prev, leftPct: v }))}
            />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {!activeProjectId ? (
              <EmptyState
                title="Choose a project"
                cta="Pick a project above to see its documents."
              />
            ) : documents.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (documents.data?.items ?? []).length === 0 ? (
              <EmptyState
                title="No documents yet"
                cta="Upload one from the project page."
                href={`/projects/${activeProjectId}`}
                hrefLabel="Open project"
              />
            ) : (
              <ul className="space-y-1 text-sm">
                {(documents.data?.items ?? []).map((d) => {
                  const attached = layout.contextIds.includes(d.id);
                  // Issue #427 — primary line shows `basename — repo` for
                  // connector ids (raw id kept in the title tooltip below); the
                  // existing secondary line keeps the directory / id-fragment
                  // provenance so nothing precise is lost.
                  const source = formatSourceLabel(d.filename);
                  const label = formatDocLabel(d.filename);
                  return (
                    <li
                      key={d.id}
                      className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent/50"
                      data-testid={`workbench-doc-${d.id}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col" title={source.rawId}>
                        <span className="truncate">{source.label}</span>
                        {label.secondary ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {label.secondary}
                          </span>
                        ) : null}
                      </span>
                      <Button
                        size="sm"
                        variant={attached ? "outline" : "default"}
                        onClick={() => (attached ? detachFromContext(d.id) : attachToContext(d.id))}
                        data-testid={`workbench-doc-attach-${d.id}`}
                      >
                        {attached ? "Attached" : "Attach"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {/* CENTER — chat */}
        <Card className="flex min-h-0 flex-col p-3" data-testid="workbench-center-panel">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Chat</h2>
            <div className="flex items-center gap-2">
              <AgentPicker
                value={layout.agentKey}
                onChange={(key) => setLayout((prev) => ({ ...prev, agentKey: key }))}
                disabled={streaming}
              />
              <span className="text-xs text-muted-foreground">
                {session ? `${session.provider} · ${session.model}` : "starting…"}
              </span>
            </div>
          </div>
          {contextDocs.length > 0 ? (
            <div
              className="mb-2 flex flex-wrap gap-1"
              data-testid="workbench-context-chips"
              role="list"
              aria-label="Context attachments"
            >
              {contextDocs.map((d) => {
                // Issue #427 — friendly `basename — repo` label on the chip; the
                // full raw id stays in the title tooltip for copy / deep-link.
                const source = formatSourceLabel(d.filename);
                return (
                  <button
                    key={d.id}
                    type="button"
                    role="listitem"
                    onClick={() => detachFromContext(d.id)}
                    title={source.rawId}
                    className="max-w-[14rem] truncate rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground hover:bg-accent/80"
                    aria-label={`Remove ${source.label} from context`}
                  >
                    📎 {source.label} ✕
                  </button>
                );
              })}
              <button
                type="button"
                onClick={clearContext}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                clear all
              </button>
            </div>
          ) : null}
          <div className="flex-1 min-h-0 overflow-y-auto rounded border p-2">
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Ask anything about this project — answers are grounded in its code &amp; docs.
                (Attach a document to focus on one file.)
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={m.isError ? "text-destructive" : ""}
                    data-testid="workbench-message"
                    data-role={m.role}
                  >
                    <strong className="mr-2 capitalize">{m.role}:</strong>
                    {m.isError ? (
                      <span className="whitespace-pre-wrap">{`⚠ ${m.content}`}</span>
                    ) : m.role === "assistant" && m.content ? (
                      <ChatMarkdown
                        content={m.content}
                        streaming={streaming && m === messages[messages.length - 1]}
                      />
                    ) : (
                      <span className="whitespace-pre-wrap">
                        {m.content || (streaming ? "…" : "")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <form
            className="relative mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
            }}
          >
            <SlashCommandPopover buffer={input} onSelect={(cmd) => setInput(cmd)} />
            <Input
              aria-label="Message"
              placeholder="Ask anything… (type / for commands)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!session || streaming}
              data-testid="workbench-input"
            />
            <Button
              type="submit"
              disabled={!session || !input.trim() || streaming}
              data-testid="workbench-send"
            >
              {streaming ? "Streaming…" : "Send"}
            </Button>
          </form>
        </Card>

        {/* RIGHT — recent + skills + tasks */}
        <Card className="flex min-h-0 flex-col gap-3 p-3" data-testid="workbench-right-panel">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent</h2>
            <PanelResizer
              ariaLabel="Resize right panel"
              value={layout.rightPct}
              onChange={(v) => setLayout((prev) => ({ ...prev, rightPct: v }))}
            />
          </div>
          <RecentList />
          <div>
            <h3 className="mb-1 text-sm font-semibold">Analyses</h3>
            {!activeProjectId ? (
              <p className="text-xs text-muted-foreground">Choose a project.</p>
            ) : analyses.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (analyses.data?.items ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No analyses yet.</p>
            ) : (
              <ul className="space-y-1 text-xs" data-testid="workbench-analyses">
                {(analyses.data?.items ?? []).slice(0, 10).map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <a
                      href={`/projects/${a.projectId}/analysis`}
                      className="truncate underline-offset-2 hover:underline"
                    >
                      {new Date(a.startedAt).toLocaleString()}
                    </a>
                    <span className="rounded bg-muted px-1.5 py-0.5">{a.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Tasks</h3>
            {tasks.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (tasks.data?.items ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent tasks.</p>
            ) : (
              <ul className="space-y-1 text-xs" data-testid="workbench-tasks">
                {(tasks.data?.items ?? []).slice(0, 10).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{t.type}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">{t.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <LoadedSkillsPanel
            sessionId={session?.id ?? null}
            projectId={activeProjectId}
            variant="inline"
          />
        </Card>
      </div>
    </div>
  );
}

function composeWithContext(input: string, attachments: DocumentRow[]): string {
  if (attachments.length === 0) return input;
  const lines = [
    `Context attachments (${attachments.length}):`,
    ...attachments.map((d) => `  - ${d.filename} (${d.id})`),
    "",
    input,
  ];
  return lines.join("\n");
}

interface ResizerProps {
  ariaLabel: string;
  value: number;
  onChange: (v: number) => void;
}

function PanelResizer({ ariaLabel, value, onChange }: ResizerProps) {
  return (
    <input
      type="range"
      min={12}
      max={50}
      step={1}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-2 w-20"
      data-testid={`resizer-${ariaLabel.replace(/\s+/g, "-").toLowerCase()}`}
    />
  );
}

interface EmptyStateProps {
  title: string;
  cta: string;
  href?: string;
  hrefLabel?: string;
}

function EmptyState({ title, cta, href, hrefLabel }: EmptyStateProps) {
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-2 rounded border border-dashed p-3 text-xs"
    >
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground">{cta}</p>
      {href && hrefLabel ? (
        <a href={href} className="text-primary underline-offset-2 hover:underline">
          {hrefLabel} →
        </a>
      ) : null}
    </div>
  );
}

function RecentList() {
  const [entries, setEntries] = useState(() => recentTracker.list());
  useEffect(() => {
    const id = window.setInterval(() => setEntries(recentTracker.list()), 5000);
    return () => window.clearInterval(id);
  }, []);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing recent yet.</p>;
  }
  return (
    <ul className="space-y-1 text-xs" data-testid="workbench-recent">
      {entries.slice(0, 10).map((e) => (
        <li key={`${e.kind}:${e.id}`} className="flex items-center justify-between gap-2">
          <a href={e.href} className="truncate underline-offset-2 hover:underline">
            {e.label || e.id}
          </a>
          <span className="rounded bg-muted px-1.5 py-0.5">{e.kind}</span>
        </li>
      ))}
    </ul>
  );
}
