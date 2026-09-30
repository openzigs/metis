/**
 * #449 — scheduling regeneration after a landed ingest never fails the ingest:
 * a failure queues a durable `schedule-regeneration` retry of the scheduling
 * step alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  check: vi.fn(async (_projectId: string, _connectorId?: string) => {}),
  upsert: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  findFirst: vi.fn(),
  readTaskRecord: vi.fn(),
  resume: vi.fn(),
  bootstrap: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../src/lib/docs-gen/incremental.js", () => ({
  checkIncrementalRegeneration: h.check,
}));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { upsert: h.upsert, updateMany: h.updateMany },
    repoConnection: { findFirst: h.findFirst },
  },
}));
vi.mock("../../src/lib/scheduler/task-store.js", () => ({ readTaskRecord: h.readTaskRecord }));
vi.mock("../../src/lib/scheduler/index.js", () => ({ getSchedulerBootstrap: h.bootstrap }));
vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ warn: h.warn, error: h.error, info: vi.fn(), debug: vi.fn() }),
}));

import {
  REGENERATION_SCHEDULING_FAILED_MESSAGE,
  REGENERATION_SCHEDULING_RETRY_UNAVAILABLE_MESSAGE,
  SCHEDULE_REGENERATION_MAX_ATTEMPTS,
  SCHEDULE_REGENERATION_TASK,
  retryRegenerationScheduling,
  scheduleIncrementalRegeneration,
} from "../../src/lib/docs-gen/regeneration-scheduling.js";
import { isDurableTask } from "../../src/lib/scheduler/durable-task-types.js";
import {
  isConnectorIngestActive,
  tryAcquireConnectorIngest,
} from "../../src/lib/connectors/ingest-guard.js";

const ID = "docs-regen-schedule:p1:rc1";

afterEach(() => vi.resetAllMocks());

function failScheduling(): Error {
  const error = new Error("outbox unavailable");
  h.check.mockRejectedValueOnce(error);
  return error;
}

describe("scheduleIncrementalRegeneration (#449)", () => {
  it("reports scheduled when the scheduling step succeeds, queueing nothing", async () => {
    await expect(scheduleIncrementalRegeneration("p1", "rc1")).resolves.toEqual({
      regenerationScheduled: true,
    });
    expect(h.check).toHaveBeenCalledExactlyOnceWith("p1", "rc1");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("queues one durable retry of the scheduling step and hands it to the queue", async () => {
    const error = failScheduling();
    h.upsert.mockResolvedValueOnce({ id: ID, status: "pending" });
    const record = { id: ID, status: "pending" };
    h.readTaskRecord.mockResolvedValueOnce(record);
    h.bootstrap.mockReturnValue({ queue: { resume: h.resume } });

    await expect(scheduleIncrementalRegeneration("p1", "rc1")).resolves.toEqual({
      regenerationScheduled: false,
      retryQueued: true,
      warning: REGENERATION_SCHEDULING_FAILED_MESSAGE,
    });
    expect(h.upsert).toHaveBeenCalledExactlyOnceWith({
      where: { id: ID },
      update: {},
      create: {
        id: ID,
        projectId: "p1",
        type: SCHEDULE_REGENERATION_TASK,
        payload: JSON.stringify({ projectId: "p1", repoConnectorId: "rc1" }),
        maxAttempts: SCHEDULE_REGENERATION_MAX_ATTEMPTS,
      },
    });
    // A pending row is not re-armed; it is dispatched.
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.resume).toHaveBeenCalledExactlyOnceWith(record);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("scheduling regeneration failed"),
      expect.objectContaining({ err: error, projectId: "p1", connectorId: "rc1" }),
    );
  });

  it.each(["completed", "failed", "cancelled"])(
    "re-arms a %s retry row with compare-and-set",
    async (status) => {
      failScheduling();
      h.upsert.mockResolvedValueOnce({ id: ID, status });
      h.readTaskRecord.mockResolvedValueOnce({ id: ID, status: "pending" });
      h.bootstrap.mockReturnValue({ queue: { resume: h.resume } });
      await scheduleIncrementalRegeneration("p1", "rc1");
      expect(h.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: ID, status },
        data: expect.objectContaining({ status: "pending", attempts: 0, errorMessage: null }),
      });
      expect(h.resume).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves a running retry alone and does not dispatch it again", async () => {
    failScheduling();
    h.upsert.mockResolvedValueOnce({ id: ID, status: "running" });
    h.readTaskRecord.mockResolvedValueOnce({ id: ID, status: "running" });
    h.bootstrap.mockReturnValue({ queue: { resume: h.resume } });
    await expect(scheduleIncrementalRegeneration("p1", "rc1")).resolves.toMatchObject({
      retryQueued: true,
    });
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it("keeps the persisted retry for durable recovery when no scheduler runs here", async () => {
    failScheduling();
    h.upsert.mockResolvedValueOnce({ id: ID, status: "pending" });
    h.readTaskRecord.mockResolvedValueOnce({ id: ID, status: "pending" });
    h.bootstrap.mockImplementation(() => {
      throw new Error("scheduler bootstrap has not been initialised");
    });
    await expect(scheduleIncrementalRegeneration("p1", "rc1")).resolves.toMatchObject({
      regenerationScheduled: false,
      retryQueued: true,
    });
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("waits for recovery"),
      expect.objectContaining({ taskId: ID }),
    );
  });

  it("says the retry could not be queued when the task store is down too", async () => {
    failScheduling();
    const queueError = new Error("task store unavailable");
    h.upsert.mockRejectedValueOnce(queueError);
    await expect(scheduleIncrementalRegeneration("p1", "rc1")).resolves.toEqual({
      regenerationScheduled: false,
      retryQueued: false,
      warning: REGENERATION_SCHEDULING_RETRY_UNAVAILABLE_MESSAGE,
    });
    expect(h.error).toHaveBeenCalledWith(
      expect.stringContaining("Could not queue"),
      expect.objectContaining({ err: queueError }),
    );
  });

  it("never puts the raw exception in the warning (#114)", async () => {
    failScheduling();
    h.upsert.mockRejectedValueOnce(new Error("postgres://secret@db"));
    const out = await scheduleIncrementalRegeneration("p1", "rc1");
    expect(JSON.stringify(out)).not.toMatch(/outbox unavailable|postgres/);
  });
});

describe("retryRegenerationScheduling (#449)", () => {
  it("is a durable outbox: recovery replays a pending retry and shutdown keeps it", () => {
    expect(isDurableTask(SCHEDULE_REGENERATION_TASK)).toBe(true);
  });

  it("runs the scheduling step for a connector of the task's project", async () => {
    h.findFirst.mockResolvedValueOnce({ id: "rc1" });
    await retryRegenerationScheduling("p1", "rc1");
    expect(h.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "rc1", projectId: "p1" },
      select: { id: true },
    });
    expect(h.check).toHaveBeenCalledExactlyOnceWith("p1", "rc1");
  });

  it("does nothing for a connector outside the project, or deleted since", async () => {
    h.findFirst.mockResolvedValueOnce(null);
    await expect(retryRegenerationScheduling("p1", "rc-other")).resolves.toBeUndefined();
    expect(h.check).not.toHaveBeenCalled();
  });

  it("propagates a scheduling failure so the queue retries it", async () => {
    h.findFirst.mockResolvedValueOnce({ id: "rc1" });
    const error = failScheduling();
    await expect(retryRegenerationScheduling("p1", "rc1")).rejects.toBe(error);
    // #498 — the lease is released on failure too.
    expect(isConnectorIngestActive("rc1")).toBe(false);
  });

  it("holds the connector's ingest lease while it schedules, then releases it (#498)", async () => {
    h.findFirst.mockResolvedValueOnce({ id: "rc1" });
    let heldDuringCheck = false;
    h.check.mockImplementationOnce(async () => {
      heldDuringCheck = isConnectorIngestActive("rc1");
      // A Sync starting now is refused rather than racing the snapshot.
      expect(tryAcquireConnectorIngest("rc1", "refresh-ingest")).toBeNull();
    });
    await retryRegenerationScheduling("p1", "rc1");
    expect(heldDuringCheck).toBe(true);
    expect(isConnectorIngestActive("rc1")).toBe(false);
  });

  it("skips while an ingest holds the connector, which schedules itself when it lands (#498)", async () => {
    h.findFirst.mockResolvedValueOnce({ id: "rc1" });
    const lease = tryAcquireConnectorIngest("rc1", "refresh-ingest")!;
    try {
      await expect(retryRegenerationScheduling("p1", "rc1")).resolves.toBeUndefined();
      expect(h.check).not.toHaveBeenCalled();
      // The running ingest's claim is untouched.
      expect(lease.held).toBe(true);
      expect(isConnectorIngestActive("rc1")).toBe(true);
    } finally {
      lease.release();
    }
  });
});
