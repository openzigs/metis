"use client";

/**
 * Task-progress socket consumer — Issue #422 (Epic #406).
 *
 * Security scans run through the scheduler task-queue, which already emits
 * `task:progress` and `task:status` to the `task:{taskId}` room (the room is
 * gated by `task.read` on the server — `server/src/lib/socket/server.ts`). The
 * scans page previously ignored these events and merely polled. This hook
 * subscribes to those EXISTING events for one task and exposes:
 *   - the latest `task:progress` (step / current / total / progress 0-100), and
 *   - the latest terminal `task:status` (completed / failed / cancelled),
 * so the scans page can render live progress and demote its poll to a safety net.
 *
 * Authorization is NOT widened here: we only subscribe to a room the server
 * already authorizes. If the user lacks `task.read`, the server rejects the
 * `subscribe:task` with an `auth:error` (surfaced by the socket client, not the
 * console) and this hook simply never receives events — the page falls back to
 * the poll. No new bus kind, no `job:lifecycle` bridge (independent of #419).
 *
 * The browser socket is loosely typed, so events are subscribed via the
 * `socket.on(<event> as never, handler as never)` escape hatch used elsewhere in
 * the UI (see `use-job-events.ts` / `use-connector-events.ts`).
 */
import { useEffect, useRef, useState } from "react";
import type { TaskProgressEvent, TaskStatusEvent } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { keepRoomSubscribed } from "@/lib/socket-subscription";
import { taskFollow } from "@/lib/socket-rooms";
import { tasksApi, type TaskRow } from "@/lib/scheduler-api";

export interface TaskProgressState {
  /** Latest in-flight progress tick, or null until the first arrives. */
  progress: TaskProgressEvent | null;
  /** Latest status transition for the task, or null until the first arrives. */
  status: TaskStatusEvent | null;
}

const EMPTY: TaskProgressState = { progress: null, status: null };

/** A terminal task status the scans row should react to (toast + refetch). */
export function isTerminalTaskStatus(status: TaskStatusEvent["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** #646 — the status event a task row stands for, as a reconnect reconciles it. */
function statusEventFromRow(row: TaskRow): TaskStatusEvent {
  return {
    taskId: row.id,
    scheduledJobId: row.scheduledJobId,
    projectId: row.projectId,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    errorMessage: row.errorMessage,
    ts: Date.parse(row.updatedAt),
  };
}

/**
 * Subscribe to a single scheduler task's progress + status events.
 *
 * Pass `null`/`undefined` (e.g. a terminal scan with no live task) to subscribe
 * to nothing and get the empty state back — so callers can use it unconditionally
 * per row without violating the rules of hooks.
 *
 * @param onTerminal optional callback fired once per terminal transition
 *   (completed/failed/cancelled). Used by the scans page to toast + refetch.
 */
export function useTaskProgress(
  taskId: string | null | undefined,
  onTerminal?: (status: TaskStatusEvent) => void,
): TaskProgressState {
  const socket = useSocket();
  const [state, setState] = useState<TaskProgressState>(EMPTY);

  // Keep the latest `onTerminal` in a ref so callers can pass a fresh closure
  // each render WITHOUT forcing a re-subscribe (which would thrash the socket
  // room). The effect depends only on [socket, taskId]; it reads `.current`.
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    if (!socket || !taskId) {
      setState(EMPTY);
      return;
    }
    // Reset when switching tasks so a previous task's progress never leaks.
    setState(EMPTY);
    let active = true;
    // The status last applied, so a reconnect that re-reads an unchanged task
    // (say, one whose terminal event did arrive) does not fire `onTerminal` twice.
    let lastStatus: TaskStatusEvent["status"] | null = null;

    const onProgress = (data: TaskProgressEvent) => {
      if (data.taskId !== taskId) return;
      setState((prev) => ({ ...prev, progress: data }));
    };
    const onStatus = (data: TaskStatusEvent) => {
      if (data.taskId !== taskId) return;
      lastStatus = data.status;
      setState((prev) => ({ ...prev, status: data }));
      if (isTerminalTaskStatus(data.status)) onTerminalRef.current?.(data);
    };
    // #646 — a `task:status` sent while the socket was down is lost, and a task
    // that finished in the gap would read as running until the next event.
    // Re-read the task on reconnect and apply its status as if it had arrived.
    const reconcile = () => {
      tasksApi
        .get(taskId)
        .then((row) => {
          if (active && row.status !== lastStatus) onStatus(statusEventFromRow(row));
        })
        .catch(() => {
          // Best-effort: the page's poll is the fallback for a failed read.
        });
    };
    // #642 — re-join on reconnect; the server drops rooms with the old session.
    const release = keepRoomSubscribed(socket, taskFollow(socket, taskId), reconcile);

    socket.on("task:progress" as never, onProgress as never);
    socket.on("task:status" as never, onStatus as never);
    return () => {
      active = false;
      release();
      socket.off("task:progress" as never, onProgress as never);
      socket.off("task:status" as never, onStatus as never);
    };
  }, [socket, taskId]);

  return state;
}
