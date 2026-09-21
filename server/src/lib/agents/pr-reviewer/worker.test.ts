/**
 * Epic #394 P2 review F4 — pr-reviewer worker tests.
 *
 * Verifies that:
 *   - DLQ jobs emit a `pr_review.dlq` audit row with the expected shape.
 *   - The periodic purge interval is wired and `clearInterval` is called
 *     on shutdown.
 *   - `shutdown()` cancels the purge AND drains the queue.
 *   - An audit error inside `onDeadLetter` does not crash the worker.
 */
import { describe, expect, it, vi } from "vitest";
import { startWorker, DEFAULT_PURGE_INTERVAL_MS } from "./worker.js";
import type { PrReviewJob } from "./queue.js";

function makePayload() {
  return {
    deliveryId: "delivery-1",
    projectId: "p1",
    owner: "acme",
    repo: "site",
    prNumber: 7,
    context: { headSha: "abc" },
  };
}

describe("startWorker", () => {
  it("emits a pr_review.dlq audit row for jobs that exhaust retries", async () => {
    const auditCalls: Array<Record<string, unknown>> = [];
    const audit = vi.fn((entry: Record<string, unknown>) => {
      auditCalls.push(entry);
    }) as unknown as typeof import("../../audit/audit-service.js").audit;

    const w = startWorker({
      processor: async () => {
        throw new Error("processor blew up");
      },
      maxAttempts: 1,
      purgeIntervalMs: 60_000,
      audit,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });

    w.queue.enqueue(makePayload());
    await w.queue.drain();

    expect(w.queue.deadLetters()).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    const entry = auditCalls[0] as {
      action: string;
      target: { type: string; id: string };
      metadata: Record<string, unknown>;
    };
    expect(entry.action).toBe("pr_review.dlq");
    expect(entry.target).toEqual({ type: "pull_request", id: "acme/site#7" });
    expect(entry.metadata.deliveryId).toBe("delivery-1");
    expect(entry.metadata.errorMessage).toBe("processor blew up");
    expect(entry.metadata.projectId).toBe("p1");

    await w.shutdown();
  });

  it("schedules the periodic dedup purge with the configured interval", async () => {
    let scheduledMs: number | null = null;
    const w = startWorker({
      processor: async () => {},
      purgeIntervalMs: 12_345,
      setInterval: (_cb, ms) => {
        scheduledMs = ms;
        return 0;
      },
      clearInterval: () => undefined,
    });
    expect(scheduledMs).toBe(12_345);
    await w.shutdown();
  });

  it("invokes purge() on each interval tick and survives purge errors", async () => {
    let intervalCb: (() => void) | null = null;
    const purge = vi.fn().mockResolvedValueOnce(3).mockRejectedValueOnce(new Error("db down"));
    const w = startWorker({
      processor: async () => {},
      purge,
      setInterval: (cb) => {
        intervalCb = cb;
        return 0;
      },
      clearInterval: () => undefined,
    });
    expect(intervalCb).not.toBeNull();
    intervalCb!();
    intervalCb!();
    // Allow microtasks to settle.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(purge).toHaveBeenCalledTimes(2);
    await w.shutdown();
  });

  it("calls clearInterval on shutdown and shuts down the queue", async () => {
    const cleared: unknown[] = [];
    const w = startWorker({
      processor: async () => {},
      setInterval: () => "interval-handle",
      clearInterval: (h) => {
        cleared.push(h);
      },
    });
    expect(w.queue.isShuttingDown()).toBe(false);
    await w.shutdown();
    expect(cleared).toEqual(["interval-handle"]);
    expect(w.queue.isShuttingDown()).toBe(true);
  });

  it("never crashes the worker when the audit emitter throws inside onDeadLetter", async () => {
    const audit = vi.fn(() => {
      throw new Error("audit broken");
    }) as unknown as typeof import("../../audit/audit-service.js").audit;
    const w = startWorker({
      processor: async () => {
        throw new Error("processor blew up");
      },
      maxAttempts: 1,
      audit,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    w.queue.enqueue(makePayload());
    await w.queue.drain();
    expect(w.queue.deadLetters()).toHaveLength(1);
    await w.shutdown();
  });

  it("exposes the default purge interval constant for callers", () => {
    expect(DEFAULT_PURGE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("forwards processor jobs through the queue with default options", async () => {
    const handled: PrReviewJob[] = [];
    const w = startWorker({
      processor: async (job) => {
        handled.push(job);
      },
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    w.queue.enqueue(makePayload());
    await w.queue.drain();
    expect(handled).toHaveLength(1);
    expect(handled[0].owner).toBe("acme");
    await w.shutdown();
  });

  // Epic #406 (#421) — the worker wires the queue's onLifecycle hook to the
  // realtime `jobEvents` bus under the `pr-review` JobKind, keyed by the SAME
  // jobId enqueue() returned and scoped to the job's project room.
  describe("job-lifecycle wiring (#421)", () => {
    type Call = [kind: string, jobId: string, projectId: string | null, rest: unknown];
    function makeJobEventsSpy() {
      const calls: Record<string, Call[]> = {
        started: [],
        progress: [],
        completed: [],
        failed: [],
      };
      return {
        calls,
        jobEvents: {
          started: (k: string, j: string, p: string | null, m?: string) =>
            calls.started.push([k, j, p, m]),
          progress: (k: string, j: string, p: string | null, prog: number, m?: string) =>
            calls.progress.push([k, j, p, { prog, m }]),
          completed: (k: string, j: string, p: string | null, m?: string) =>
            calls.completed.push([k, j, p, m]),
          failed: (k: string, j: string, p: string | null, e: string) =>
            calls.failed.push([k, j, p, e]),
        },
      };
    }

    it("emits pr-review started → progress → completed keyed by the enqueue jobId + project room", async () => {
      const spy = makeJobEventsSpy();
      const w = startWorker({
        processor: async () => {},
        setInterval: () => 0,
        clearInterval: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jobEvents: spy.jobEvents as any,
      });
      const { jobId } = w.queue.enqueue(makePayload());
      await w.queue.drain();

      expect(spy.calls.started).toHaveLength(1);
      expect(spy.calls.completed).toHaveLength(1);
      expect(spy.calls.failed).toHaveLength(0);
      // kind is "pr-review", keyed by the enqueue jobId, scoped to project p1.
      expect(spy.calls.started[0][0]).toBe("pr-review");
      expect(spy.calls.started[0][1]).toBe(jobId);
      expect(spy.calls.started[0][2]).toBe("p1");
      expect(spy.calls.progress.length).toBeGreaterThanOrEqual(1);
      expect(spy.calls.completed[0][1]).toBe(jobId);
      expect(spy.calls.completed[0][2]).toBe("p1");
      await w.shutdown();
    });

    it("emits a pr-review failed event with the GENERIC user-safe message (no raw error leak)", async () => {
      const spy = makeJobEventsSpy();
      const w = startWorker({
        processor: async () => {
          throw new Error("SECRET stack trace with db dsn postgres://user:pass@host");
        },
        maxAttempts: 1,
        setInterval: () => 0,
        clearInterval: () => undefined,
        audit: vi.fn() as unknown as typeof import("../../audit/audit-service.js").audit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jobEvents: spy.jobEvents as any,
      });
      const { jobId } = w.queue.enqueue(makePayload());
      await w.queue.drain();

      expect(spy.calls.completed).toHaveLength(0);
      expect(spy.calls.failed).toHaveLength(1);
      const [kind, jid, projectId, message] = spy.calls.failed[0];
      expect(kind).toBe("pr-review");
      expect(jid).toBe(jobId);
      expect(projectId).toBe("p1");
      // The user-safe generic message, NOT the raw error / secret.
      expect(message).toBe("The pull request review failed. Please try again.");
      expect(String(message)).not.toMatch(/SECRET|postgres:\/\/|pass@/);
      await w.shutdown();
    });
  });
});
