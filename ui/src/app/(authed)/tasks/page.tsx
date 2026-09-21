"use client";

/**
 * Phase 11 — /tasks
 *
 * Task queue view: tabs per status, expand for payload/error, cancel running
 * tasks, retry failed/cancelled ones. Subscribes to `scheduler:status` so
 * status changes appear without a manual refresh.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { tasksApi, type TaskRow } from "@/lib/scheduler-api";
import { queryKeys } from "@/lib/query-keys";
import { useSocket } from "@/lib/socket-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const TABS = ["pending", "running", "completed", "failed", "cancelled"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  pending: "Waiting",
  running: "In flight",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function TasksPage() {
  const qc = useQueryClient();
  const socket = useSocket();
  const [tab, setTab] = useState<Tab>("running");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.tasks.list({ status: tab, take: 100 }),
    queryFn: () => tasksApi.list({ status: tab, take: 100 }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.tasks.all }).catch(() => {});

  useEffect(() => {
    if (!socket) return;
    socket.emit("subscribe:scheduler");
    const onChange = () => invalidate();
    socket.on("task:status", onChange);
    socket.on("task:progress", onChange);
    return () => {
      socket.off("task:status", onChange);
      socket.off("task:progress", onChange);
    };
  }, [socket, qc]);

  const cancel = useMutation({
    mutationFn: (id: string) => tasksApi.cancel(id),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) setActionError(err.message);
      else setActionError("Cancel failed");
    },
  });
  const retry = useMutation({
    mutationFn: (id: string) => tasksApi.retry(id),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) setActionError(err.message);
      else setActionError("Retry failed");
    },
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-6 p-2 md:p-0">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Task queue across the platform — scheduled fires, manual triggers, retries, and webhook
          callbacks. Live status streams in over Socket.IO.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <Button
            key={t}
            variant={t === tab ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(t)}
            data-testid={`tab-${t}`}
            role="tab"
            aria-selected={t === tab}
          >
            {TAB_LABELS[t]}
          </Button>
        ))}
      </div>

      {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Task</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Trigger</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  No tasks in {TAB_LABELS[tab]}.
                </td>
              </tr>
            ) : (
              items.map((task: TaskRow) => (
                <TaskRowView
                  key={task.id}
                  task={task}
                  expanded={expanded.has(task.id)}
                  onToggle={() => toggle(task.id)}
                  onCancel={() => cancel.mutate(task.id)}
                  onRetry={() => retry.mutate(task.id)}
                  cancelDisabled={cancel.isPending}
                  retryDisabled={retry.isPending}
                />
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

interface TaskRowViewProps {
  task: TaskRow;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
  cancelDisabled: boolean;
  retryDisabled: boolean;
}

function TaskRowView({
  task,
  expanded,
  onToggle,
  onCancel,
  onRetry,
  cancelDisabled,
  retryDisabled,
}: TaskRowViewProps) {
  const isCancellable = task.status === "pending" || task.status === "running";
  const isRetryable = task.status === "failed" || task.status === "cancelled";
  return (
    <>
      <tr className="border-t" data-testid={`task-row-${task.id}`}>
        <td className="px-4 py-2">
          <button
            type="button"
            onClick={onToggle}
            className="font-mono text-xs underline-offset-2 hover:underline"
            data-testid={`expand-${task.id}`}
          >
            {expanded ? "▾" : "▸"} {task.id}
          </button>
        </td>
        <td className="px-4 py-2 font-mono text-xs">{task.type}</td>
        <td className="px-4 py-2 text-xs">{task.trigger}</td>
        <td className="px-4 py-2 text-xs">
          {task.attempts}/{task.maxAttempts}
        </td>
        <td className="px-4 py-2 text-xs">{new Date(task.createdAt).toLocaleString()}</td>
        <td className="px-4 py-2">
          <div className="flex justify-end gap-2">
            {isCancellable ? (
              <Button
                size="sm"
                variant="outline"
                disabled={cancelDisabled}
                onClick={onCancel}
                data-testid={`cancel-${task.id}`}
              >
                Cancel
              </Button>
            ) : null}
            {isRetryable ? (
              <Button
                size="sm"
                variant="outline"
                disabled={retryDisabled}
                onClick={onRetry}
                data-testid={`retry-${task.id}`}
              >
                Retry
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t bg-muted/30">
          <td colSpan={6} className="px-4 py-3">
            <div className="space-y-2">
              {task.errorMessage ? (
                <div>
                  <p className="text-xs font-semibold text-destructive">Error</p>
                  <pre className="whitespace-pre-wrap break-words text-xs">{task.errorMessage}</pre>
                </div>
              ) : null}
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Payload</p>
                <pre className="whitespace-pre-wrap break-words text-xs font-mono">
                  {prettyJson(task.payload)}
                </pre>
              </div>
              {task.result ? (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">Result</p>
                  <pre className="whitespace-pre-wrap break-words text-xs font-mono">
                    {prettyJson(task.result)}
                  </pre>
                </div>
              ) : null}
              {task.progress != null ? (
                <p className="text-xs text-muted-foreground">Progress: {task.progress}%</p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function prettyJson(s: string | null): string {
  if (!s) return "—";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
