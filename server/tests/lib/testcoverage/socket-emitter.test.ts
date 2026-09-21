/**
 * Tests for the test-coverage Socket.IO emitter (Epic #880 issue #886).
 */
import { describe, it, expect, vi } from "vitest";
import { createSocketTestCoverageEmitter } from "../../../src/lib/testcoverage/socket-emitter.js";
import type { MetisIOServer } from "../../../src/lib/socket/server.js";
import type { TestCoverageEvent } from "../../../src/lib/testcoverage/task-runner.js";

function makeIo() {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  return { io: { to } as unknown as MetisIOServer, to, emit };
}

describe("createSocketTestCoverageEmitter", () => {
  it("emits progress events to the project room as run-update", () => {
    const { io, to, emit } = makeIo();
    const emitter = createSocketTestCoverageEmitter(io);
    const event: TestCoverageEvent = {
      type: "run:progress",
      runId: "run-1",
      projectId: "p-1",
      phase: "judge",
      detail: { batches: 2 },
    };
    emitter(event);
    expect(to).toHaveBeenCalledWith("project:p-1");
    expect(emit).toHaveBeenCalledWith(
      "testcoverage:run-update",
      expect.objectContaining({ type: "run:progress", runId: "run-1", phase: "judge" }),
    );
  });

  it("maps terminal events to run-finished", () => {
    const { io, emit } = makeIo();
    const emitter = createSocketTestCoverageEmitter(io);
    emitter({ type: "run:completed", runId: "run-1", projectId: "p-1" });
    expect(emit).toHaveBeenCalledWith(
      "testcoverage:run-finished",
      expect.objectContaining({ type: "run:completed" }),
    );
  });

  it("maps failures to run-finished with the error", () => {
    const { io, emit } = makeIo();
    const emitter = createSocketTestCoverageEmitter(io);
    emitter({ type: "run:failed", runId: "run-1", projectId: "p-1", error: "boom" });
    expect(emit).toHaveBeenCalledWith(
      "testcoverage:run-finished",
      expect.objectContaining({ type: "run:failed", error: "boom" }),
    );
  });
});
