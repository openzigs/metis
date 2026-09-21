/**
 * Epic #394 P2 (#403) — in-memory queue unit tests.
 */
import { describe, expect, it } from "vitest";
import { createPrReviewQueue, type PrReviewJob } from "./queue.js";

function makePayload(
  overrides: Partial<{ deliveryId: string; owner: string; repo: string; prNumber: number }> = {},
) {
  return {
    deliveryId: overrides.deliveryId ?? "d1",
    projectId: "p1",
    owner: overrides.owner ?? "acme",
    repo: overrides.repo ?? "site",
    prNumber: overrides.prNumber ?? 1,
    context: {},
  };
}

describe("createPrReviewQueue", () => {
  it("dispatches jobs through the processor and reports queue depth", async () => {
    const seen: PrReviewJob[] = [];
    const q = createPrReviewQueue({
      processor: async (job) => {
        seen.push(job);
      },
    });
    q.enqueue(makePayload({ deliveryId: "a" }));
    q.enqueue(makePayload({ deliveryId: "b" }));
    expect(q.depth()).toBeGreaterThanOrEqual(0);
    await q.drain();
    expect(seen.map((s) => s.deliveryId).sort()).toEqual(["a", "b"]);
  });

  it("retries with backoff and lands in the DLQ after maxAttempts", async () => {
    const errs: Error[] = [];
    let attempts = 0;
    const timers: Array<{ cb: () => void; delay: number }> = [];
    const q = createPrReviewQueue({
      processor: async () => {
        attempts += 1;
        throw new Error("boom");
      },
      maxAttempts: 3,
      backoffMs: [10, 20],
      setTimer: (cb, ms) => {
        timers.push({ cb, delay: ms });
        return 0;
      },
      onDeadLetter: (_job, err) => {
        errs.push(err);
      },
    });
    q.enqueue(makePayload());
    // Drain wave 1
    await new Promise((r) => setImmediate(r));
    expect(attempts).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(10);

    // Fire the first retry
    timers[0].cb();
    await new Promise((r) => setImmediate(r));
    expect(attempts).toBe(2);
    expect(timers).toHaveLength(2);
    expect(timers[1].delay).toBe(20);

    // Fire the second retry — should DLQ instead of scheduling another timer
    timers[1].cb();
    await new Promise((r) => setImmediate(r));
    expect(attempts).toBe(3);
    expect(q.deadLetters()).toHaveLength(1);
    expect(errs[0].message).toBe("boom");
    expect(timers).toHaveLength(2);
  });

  it("respects per-repo concurrency cap", async () => {
    let concurrent = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let releaseThird!: () => void;
    const gates = [
      new Promise<void>((res) => (releaseFirst = res)),
      new Promise<void>((res) => (releaseSecond = res)),
      new Promise<void>((res) => (releaseThird = res)),
    ];
    let i = 0;
    const q = createPrReviewQueue({
      concurrencyPerRepo: 2,
      processor: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        const idx = i++;
        await gates[idx];
        concurrent -= 1;
      },
    });
    q.enqueue(makePayload({ deliveryId: "1" }));
    q.enqueue(makePayload({ deliveryId: "2" }));
    q.enqueue(makePayload({ deliveryId: "3" }));
    await new Promise((r) => setImmediate(r));
    expect(peak).toBe(2);
    releaseFirst();
    releaseSecond();
    releaseThird();
    await q.drain();
    expect(peak).toBe(2);
  });

  it("does NOT cross-block different repos", async () => {
    let concurrent = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const q = createPrReviewQueue({
      concurrencyPerRepo: 1,
      processor: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((res) => releases.push(res));
        concurrent -= 1;
      },
    });
    q.enqueue(makePayload({ deliveryId: "a", owner: "o1", repo: "r1" }));
    q.enqueue(makePayload({ deliveryId: "b", owner: "o2", repo: "r2" }));
    await new Promise((r) => setImmediate(r));
    // Two repos × concurrency 1 = 2 concurrent
    expect(peak).toBe(2);
    releases.forEach((r) => r());
    await q.drain();
  });

  it("isolates DLQ-callback errors from the worker loop", async () => {
    let processedAfter = false;
    const q = createPrReviewQueue({
      processor: async (job) => {
        if (job.deliveryId === "fail") throw new Error("nope");
        processedAfter = true;
      },
      maxAttempts: 1,
      onDeadLetter: () => {
        throw new Error("dlq sink threw");
      },
    });
    q.enqueue(makePayload({ deliveryId: "fail" }));
    q.enqueue(makePayload({ deliveryId: "ok" }));
    await q.drain();
    expect(processedAfter).toBe(true);
    expect(q.deadLetters()).toHaveLength(1);
  });

  it("uses default backoff when not provided", async () => {
    const timers: number[] = [];
    const q = createPrReviewQueue({
      processor: async () => {
        throw new Error("x");
      },
      maxAttempts: 2,
      setTimer: (cb, ms) => {
        timers.push(ms);
        cb();
        return 0;
      },
    });
    q.enqueue(makePayload());
    await q.drain();
    expect(timers[0]).toBe(1000);
  });

  it("returns a stable jobId from enqueue", () => {
    const q = createPrReviewQueue({ processor: async () => {} });
    const out = q.enqueue(makePayload({ deliveryId: "" }));
    expect(out.jobId).toMatch(/^prr-\d+/);
    expect(out.queueDepth).toBeGreaterThanOrEqual(0);
  });

  // Epic #406 (#421) — lifecycle hook so the queue is the single place that
  // emits started/progress/completed/failed keyed by the SAME jobId returned
  // by enqueue(). Covers AC: re-review-emits-lifecycle (started→progress→
  // completed) and the failure path.
  describe("onLifecycle hook (#421)", () => {
    interface Event {
      phase: "started" | "progress" | "completed" | "failed";
      jobId: string;
      projectId: string;
      prNumber: number;
      progress?: number;
      error?: string;
    }

    it("emits started → progress → completed for a successful job, keyed by the enqueue jobId", async () => {
      const events: Event[] = [];
      const q = createPrReviewQueue({
        processor: async () => {},
        onLifecycle: (e) => events.push(e),
      });
      const out = q.enqueue(makePayload({ deliveryId: "ok", prNumber: 5 }));
      await q.drain();

      expect(events.map((e) => e.phase)).toEqual(["started", "progress", "completed"]);
      // Every event is keyed by the SAME jobId returned by enqueue().
      expect(events.every((e) => e.jobId === out.jobId)).toBe(true);
      expect(events.every((e) => e.projectId === "p1")).toBe(true);
      expect(events.every((e) => e.prNumber === 5)).toBe(true);
      // The completed event reports 100%.
      const completed = events.find((e) => e.phase === "completed")!;
      expect(completed.progress).toBe(100);
    });

    it("emits a terminal failed event (with the error) only after retries are exhausted (DLQ)", async () => {
      const events: Event[] = [];
      // Drive retries with a controlled timer (fire synchronously) so the
      // assertion doesn't race a real setTimeout vs the drain yield.
      const timers: Array<() => void> = [];
      const q = createPrReviewQueue({
        processor: async () => {
          throw new Error("review blew up");
        },
        maxAttempts: 2,
        backoffMs: [10],
        setTimer: (cb) => {
          timers.push(cb);
          return 0;
        },
        onLifecycle: (e) => events.push(e),
      });
      const out = q.enqueue(makePayload({ deliveryId: "boom" }));
      // Attempt 1 ran inline + scheduled one retry timer.
      await new Promise((r) => setImmediate(r));
      expect(events.filter((e) => e.phase === "failed")).toHaveLength(0);
      // Fire the retry — attempt 2 fails and exhausts retries → DLQ + failed.
      timers[0]();
      await new Promise((r) => setImmediate(r));

      const failed = events.filter((e) => e.phase === "failed");
      const completed = events.filter((e) => e.phase === "completed");
      // Exactly one terminal failed (on DLQ), no completed.
      expect(failed).toHaveLength(1);
      expect(completed).toHaveLength(0);
      expect(failed[0].jobId).toBe(out.jobId);
      expect(failed[0].error).toBe("review blew up");
      expect(q.deadLetters()).toHaveLength(1);
    });

    it("does NOT emit failed on an intermediate (retryable) failure — only on final DLQ", async () => {
      const events: Event[] = [];
      const timers: Array<() => void> = [];
      const q = createPrReviewQueue({
        processor: async (job) => {
          if (job.attempt < 2) throw new Error("transient");
        },
        maxAttempts: 2,
        backoffMs: [10],
        setTimer: (cb) => {
          timers.push(cb);
          return 0;
        },
        onLifecycle: (e) => events.push(e),
      });
      q.enqueue(makePayload({ deliveryId: "retry" }));
      // Attempt 1 failed (retryable) — no terminal failed yet.
      await new Promise((r) => setImmediate(r));
      expect(events.filter((e) => e.phase === "failed")).toHaveLength(0);
      // Fire the retry — attempt 2 succeeds.
      timers[0]();
      await new Promise((r) => setImmediate(r));

      // The retry eventually succeeds: no failed, exactly one completed.
      expect(events.filter((e) => e.phase === "failed")).toHaveLength(0);
      expect(events.filter((e) => e.phase === "completed")).toHaveLength(1);
    });

    it("never lets an onLifecycle callback error crash the worker loop", async () => {
      let processed = false;
      const q = createPrReviewQueue({
        processor: async () => {
          processed = true;
        },
        onLifecycle: () => {
          throw new Error("hook threw");
        },
      });
      q.enqueue(makePayload());
      await q.drain();
      expect(processed).toBe(true);
    });
  });

  it("converts non-Error throws into Error in DLQ", async () => {
    let captured: Error | null = null;
    const q = createPrReviewQueue({
      processor: async () => {
        throw "string-error";
      },
      maxAttempts: 1,
      onDeadLetter: (_j, err) => {
        captured = err;
      },
    });
    q.enqueue(makePayload());
    await q.drain();
    expect(captured).toBeInstanceOf(Error);
    expect((captured as unknown as Error).message).toBe("string-error");
  });

  it("drain yields when nothing is in-flight but a retry is pending via setTimer", async () => {
    // Use the DEFAULT setTimer (real setTimeout) so the corresponding fallback
    // arrow on `createPrReviewQueue` is exercised. Tiny backoff = 1ms.
    const q = createPrReviewQueue({
      processor: async (job) => {
        if (job.attempt < 2) throw new Error("retry me");
      },
      maxAttempts: 2,
      backoffMs: [1],
    });
    q.enqueue(makePayload());
    await q.drain();
    expect(q.deadLetters()).toHaveLength(0);
  });

  // Epic #394 P2 review F4 / C2 — graceful shutdown.
  describe("shutdown()", () => {
    it("rejects new enqueues with a sentinel jobId after shutdown is called", async () => {
      const q = createPrReviewQueue({ processor: async () => {} });
      await q.shutdown();
      const out = q.enqueue(makePayload());
      expect(out.jobId).toBe("prr-shutdown-rejected");
      expect(out.queueDepth).toBe(-1);
      expect(q.isShuttingDown()).toBe(true);
    });

    it("cancels pending retry timers so they do not re-enqueue post-shutdown", async () => {
      // Manual timer pump so we control the retry firing precisely.
      const queued: Array<() => void> = [];
      const attempts: number[] = [];
      const q = createPrReviewQueue({
        processor: async (job) => {
          attempts.push(job.attempt);
          throw new Error("always fails");
        },
        maxAttempts: 5,
        backoffMs: [10, 10, 10, 10],
        setTimer: (cb) => {
          queued.push(cb);
          return 0;
        },
      });
      q.enqueue(makePayload());
      // First attempt ran inline; one retry timer is queued.
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toEqual([1]);
      expect(queued.length).toBe(1);

      // Shutdown BEFORE the retry timer fires.
      await q.shutdown();
      // Now fire the queued timer — it must be a no-op because shutdown
      // cancelled it.
      const beforeAttempts = attempts.length;
      queued[0]();
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts.length).toBe(beforeAttempts);
      // No new retry timer should have been scheduled.
      expect(queued.length).toBe(1);
    });

    it("drops queued (not-yet-running) jobs and is idempotent", async () => {
      // Slow processor so the second enqueue stays pending past shutdown.
      let releaseFirst!: () => void;
      const firstStarted = new Promise<void>((res) => {
        const p = new Promise<void>((rel) => {
          releaseFirst = rel;
        });
        // start signal fires when processor begins
        void p.then(() => {});
        return res;
      });
      void firstStarted;
      let started = 0;
      const q = createPrReviewQueue({
        processor: async () => {
          started += 1;
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
        },
        concurrencyPerRepo: 1,
      });
      q.enqueue(makePayload());
      q.enqueue(makePayload({ deliveryId: "second" }));
      q.enqueue(makePayload({ deliveryId: "third" }));
      // First job is in-flight, second + third are queued.
      await Promise.resolve();
      expect(started).toBe(1);
      const shutdownPromise = q.shutdown();
      // Release the in-flight processor so shutdown can return.
      releaseFirst();
      await shutdownPromise;
      // Idempotent — second call resolves immediately and does not throw.
      await q.shutdown();
      expect(q.depth()).toBe(0);
    });
  });
});
