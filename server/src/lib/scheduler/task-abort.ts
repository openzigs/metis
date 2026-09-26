/**
 * Issue #201 — why a task's signal was aborted, readable by the handler.
 *
 * The queue aborts a running task for three reasons that a handler must treat
 * differently: a user's cancellation is terminal, a timeout is a failed attempt
 * (retried unless it was the last), and a shutdown is an interruption the durable
 * outbox replays on the next start. The signal's `reason` carries which one, so a
 * handler that records an outcome (generated-doc publication) can record the
 * right one instead of recording nothing on every abort.
 */
export type TaskAbortSource = "user" | "shutdown" | "timeout";

export class TaskAbortError extends Error {
  readonly source: TaskAbortSource;

  constructor(source: TaskAbortSource, message: string) {
    super(message);
    this.name = "TaskAbortError";
    this.source = source;
  }
}

/**
 * The abort source of `signal`, or `undefined` when it is not aborted or was
 * aborted by something other than the task queue (a caller's own controller).
 */
export function taskAbortSource(signal: AbortSignal | undefined): TaskAbortSource | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  return reason instanceof TaskAbortError ? reason.source : undefined;
}
