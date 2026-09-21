/**
 * Epic #880 — Issue #886 — test-coverage realtime emitter.
 *
 * Bridges {@link TestCoverageEvent}s emitted by the background runner into
 * the `project:{projectId}` Socket.IO room so the test-coverage workbench
 * reacts to run progress without polling. Terminal events
 * (`run:completed` / `run:failed`) map to `testcoverage:run-finished`; all
 * other lifecycle events map to `testcoverage:run-update`, matching the
 * event names the UI subscribes to.
 *
 * Wired in `server.ts` once the live `io` is ready.
 */
import type { MetisIOServer } from "../socket/server.js";
import type { TestCoverageEmitter, TestCoverageEvent } from "./task-runner.js";

export function createSocketTestCoverageEmitter(io: MetisIOServer): TestCoverageEmitter {
  return (event: TestCoverageEvent): void => {
    const channel =
      event.type === "run:completed" || event.type === "run:failed"
        ? "testcoverage:run-finished"
        : "testcoverage:run-update";
    io.to(`project:${event.projectId}`).emit(channel, {
      type: event.type,
      runId: event.runId,
      projectId: event.projectId,
      phase: event.phase,
      detail: event.detail,
      error: event.error,
    });
  };
}
