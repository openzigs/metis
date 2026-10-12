/**
 * #1059 — the Spec Kit job runner's rules, on an in-memory job table.
 *
 * Every wait here is on an event (a deferred the test controls, or a state the
 * test polls for with a generous ceiling). Nothing asserts that something took
 * less than a wall-clock figure: CI is several times slower than a laptop.
 *
 * The real table — the unique index and the compare-and-set writes — is
 * exercised through the real router in `spec-kit-jobs-1059.sqlite.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jobEvents, auditSpy, recordJobScope, configValues } = vi.hoisted(() => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    lifecycle: vi.fn(),
    docSection: vi.fn(),
  },
  auditSpy: vi.fn(),
  recordJobScope: vi.fn(async () => undefined),
  configValues: new Map<string, number>(),
}));
vi.mock("../src/lib/socket/job-events.js", () => ({
  jobEvents,
  genericFailureMessage: (kind: string) => `GENERIC:${kind}`,
}));
vi.mock("../src/lib/socket/job-scope-store.js", () => ({ recordJobScope }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));
vi.mock("../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getNumber: (key: string, fallback: number) => configValues.get(key) ?? fallback,
  }),
}));
vi.mock("../src/lib/spec-kit/job-store.js", async () => {
  const fake = await import("./helpers/spec-kit-job-store-fake.js");
  return fake.fakeSpecKitJobStore;
});

import {
  fakeSpecKitJobRows,
  fakeSpecKitJobStore,
  plantFakeSpecKitJob,
  resetFakeSpecKitJobStore,
} from "./helpers/spec-kit-job-store-fake.js";
import {
  DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS,
  SPEC_KIT_JOB_CANCELLED_MESSAGE,
  SPEC_KIT_JOB_RETENTION_MS,
  SPEC_KIT_JOB_STALE_MS,
  SpecKitJobConflictError,
  SpecKitJobSavingError,
  _resetSpecKitJobs,
  cancelSpecKitJob,
  extractCompletionMessage,
  failInterruptedSpecKitJobs,
  getSpecKitJob,
  listActiveSpecKitJobs,
  liveSpecKitJobCount,
  resolveSpecKitJobTimeoutMs,
  specKitJobActiveKey,
  startSpecKitJob,
  startSpecKitJobSweeper,
  toSpecKitJobDto,
  type StartSpecKitJobInput,
} from "../src/lib/spec-kit/jobs.js";
import {
  SpecKitJobStopError,
  currentSpecKitJob,
  reportSpecKitJobPhase,
  specKitJobCommitPoint,
  throwIfSpecKitJobStopped,
} from "../src/lib/spec-kit/job-scope.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SLUG = "001-mark-read";
const base = (over: Partial<StartSpecKitJobInput> = {}): StartSpecKitJobInput => ({
  projectId: "p1",
  command: "speckit.plan",
  featureSlug: SLUG,
  actorId: "u1",
  run: async () => ({ message: "done" }),
  ...over,
});
/** A row older than the stale threshold by a wide margin. */
const longAgo = (): Date => new Date(Date.now() - SPEC_KIT_JOB_STALE_MS * 10);

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeSpecKitJobStore();
  configValues.clear();
});
afterEach(() => {
  _resetSpecKitJobs();
});

describe("startSpecKitJob — the command runs after the start returns", () => {
  it("returns a running job while the command is still waiting, then stores its result", async () => {
    const gate = deferred<{ message: string; artifacts: string[] }>();
    const started = await startSpecKitJob(base({ run: () => gate.promise }));

    expect(started.job).toMatchObject({
      projectId: "p1",
      command: "speckit.plan",
      featureSlug: SLUG,
      status: "running",
      startedById: "u1",
      finishedAt: null,
    });
    expect(started.job).not.toHaveProperty("result");
    expect(await getSpecKitJob("p1", started.job.id)).toMatchObject({ status: "running" });
    expect(liveSpecKitJobCount()).toBe(1);

    gate.resolve({ message: "Generated 5 plan artifacts", artifacts: ["plan.md"] });
    const done = await started.done;

    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ message: "Generated 5 plan artifacts", artifacts: ["plan.md"] });
    expect(done.finishedAt).not.toBeNull();
    expect(liveSpecKitJobCount()).toBe(0);
    // The stored job is what a later poll reads.
    expect(await getSpecKitJob("p1", started.job.id)).toEqual(done);
  });

  it("records the job's scope before the id leaves, and streams started → completed", async () => {
    const order: string[] = [];
    recordJobScope.mockImplementationOnce(async () => {
      order.push("scope");
    });
    jobEvents.started.mockImplementationOnce(() => order.push("started"));
    const started = await startSpecKitJob(
      base({ label: "/plan", run: async () => ({ message: "Generated plan.md (v2)." }) }),
    );
    await started.done;

    expect(order).toEqual(["scope", "started"]);
    expect(recordJobScope).toHaveBeenCalledWith(started.job.id, "spec-kit", "p1");
    expect(jobEvents.started).toHaveBeenCalledWith(
      "spec-kit",
      started.job.id,
      "p1",
      "Running /plan",
    );
    // #423 — the grounded-completion line is the terminal message, verbatim.
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "spec-kit",
      started.job.id,
      "p1",
      "Generated plan.md (v2).",
    );
    expect(jobEvents.failed).not.toHaveBeenCalled();
  });

  it("falls back to a generic completion line for a result without a message", async () => {
    const started = await startSpecKitJob(base({ run: async () => undefined }));
    const done = await started.done;
    expect(done.result).toBeNull();
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "spec-kit",
      started.job.id,
      "p1",
      "/speckit.plan completed.",
    );
  });

  it("runs the command inside the job's scope", async () => {
    let seen: string | undefined;
    const started = await startSpecKitJob(
      base({
        run: async () => {
          seen = currentSpecKitJob()?.jobId;
          return {};
        },
      }),
    );
    await started.done;
    expect(seen).toBe(started.job.id);
    expect(currentSpecKitJob()).toBeUndefined();
  });
});

describe("startSpecKitJob — failures keep the route's error contract", () => {
  it("stores the mapped status, code, message and details, and emits only a generic event", async () => {
    const started = await startSpecKitJob(
      base({
        run: async () => {
          throw new Error("provider said: sk-secret-123");
        },
        mapError: () => ({
          status: 502,
          code: "SPEC_KIT_EMPTY_OUTPUT",
          message: "/plan: the model returned an empty reply.",
          details: { required: "specGate" },
        }),
      }),
    );
    const done = await started.done;

    expect(done.status).toBe("failed");
    expect(done.error).toEqual({
      status: 502,
      code: "SPEC_KIT_EMPTY_OUTPUT",
      message: "/plan: the model returned an empty reply.",
      details: { required: "specGate" },
    });
    expect(done).not.toHaveProperty("result");
    // #254 — the raw error never reaches the socket.
    expect(jobEvents.failed).toHaveBeenCalledWith(
      "spec-kit",
      started.job.id,
      "p1",
      "GENERIC:spec-kit",
    );
    expect(JSON.stringify(jobEvents.failed.mock.calls)).not.toContain("sk-secret");
  });

  it("stores a generic 500, never the raw message, when nothing maps the error", async () => {
    const started = await startSpecKitJob(
      base({
        run: async () => {
          throw new Error("connection string postgres://user:pw@db");
        },
      }),
    );
    const done = await started.done;
    expect(done.error).toEqual({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
    expect(JSON.stringify([...fakeSpecKitJobRows.values()])).not.toContain("postgres://");
  });

  it("still finishes the job when the mapper itself throws", async () => {
    const started = await startSpecKitJob(
      base({
        run: async () => {
          throw new Error("boom");
        },
        mapError: () => {
          throw new Error("mapper bug");
        },
      }),
    );
    expect((await started.done).error?.code).toBe("INTERNAL_ERROR");
  });

  it("reports an interrupted job, and does not reject, when the outcome cannot be stored", async () => {
    const finish = vi
      .spyOn(fakeSpecKitJobStore, "finishJob")
      .mockRejectedValueOnce(new Error("database is locked"));
    const started = await startSpecKitJob(base());
    const done = await started.done;
    finish.mockRestore();

    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("SPEC_KIT_JOB_INTERRUPTED");
    expect(jobEvents.completed).not.toHaveBeenCalled();
  });
});

describe("duplicate start — never two writers of one artifact set", () => {
  it("refuses a second start on the same feature and names the job that holds it", async () => {
    const gate = deferred();
    const first = await startSpecKitJob(base({ run: () => gate.promise }));
    const second = vi.fn(async () => ({}));

    const refusal = await startSpecKitJob(base({ command: "speckit.tasks", run: second })).catch(
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(SpecKitJobConflictError);
    expect((refusal as SpecKitJobConflictError).holder).toMatchObject({
      id: first.job.id,
      command: "speckit.plan",
      featureSlug: SLUG,
    });
    expect((refusal as SpecKitJobConflictError).message).toContain("/speckit.plan");
    // The refused command never ran, and nothing was recorded for it.
    expect(second).not.toHaveBeenCalled();
    expect(fakeSpecKitJobRows.size).toBe(1);
    expect(recordJobScope).toHaveBeenCalledTimes(1);

    gate.resolve({});
    await first.done;
  });

  it("lets another feature, another project and the project-level set run alongside", async () => {
    const gate = deferred();
    const run = (): Promise<unknown> => gate.promise;
    const jobs = [
      await startSpecKitJob(base({ run })),
      await startSpecKitJob(base({ run, featureSlug: "002-other" })),
      await startSpecKitJob(base({ run, featureSlug: null })),
      await startSpecKitJob(base({ run, projectId: "p2" })),
    ];
    expect(new Set(jobs.map((j) => j.job.id)).size).toBe(4);
    expect(specKitJobActiveKey("p1", null)).not.toBe(specKitJobActiveKey("p1", SLUG));
    gate.resolve({});
    await Promise.all(jobs.map((j) => j.done));
  });

  it("releases the feature when the job ends, whatever the outcome", async () => {
    for (const run of [
      async () => ({}),
      async () => {
        throw new Error("x");
      },
    ]) {
      const job = await startSpecKitJob(base({ run }));
      await job.done;
      expect(fakeSpecKitJobRows.get(job.job.id)?.activeKey).toBeNull();
    }
    await expect(startSpecKitJob(base())).resolves.toBeTruthy();
  });

  it("takes over a feature whose job has no live process, failing that job as interrupted", async () => {
    plantFakeSpecKitJob({
      id: "dead",
      featureSlug: SLUG,
      activeKey: specKitJobActiveKey("p1", SLUG),
      heartbeatAt: longAgo(),
    });

    const started = await startSpecKitJob(base());
    await started.done;

    expect(started.job.id).not.toBe("dead");
    expect(await getSpecKitJob("p1", "dead")).toMatchObject({
      status: "failed",
      error: { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED" },
    });
  });

  it("does not take over a job whose heartbeat is fresh", async () => {
    plantFakeSpecKitJob({
      id: "alive",
      featureSlug: SLUG,
      activeKey: specKitJobActiveKey("p1", SLUG),
    });
    await expect(startSpecKitJob(base())).rejects.toBeInstanceOf(SpecKitJobConflictError);
    expect(fakeSpecKitJobRows.get("alive")?.status).toBe("running");
  });
});

describe("cancel — honoured until the job starts saving, never after", () => {
  it("ends the job at once, aborts its model call, and refuses the write the command later tries", async () => {
    const reply = deferred<string>();
    let signal: AbortSignal | undefined;
    let lateWrite: unknown = "not attempted";
    const written = vi.fn();
    const started = await startSpecKitJob(
      base({
        run: async () => {
          signal = currentSpecKitJob()?.signal;
          await reply.promise; // the model call the cancel interrupts
          try {
            specKitJobCommitPoint();
            written();
            lateWrite = "written";
          } catch (err) {
            lateWrite = err;
            throw err;
          }
          return {};
        },
      }),
    );

    const cancelled = await cancelSpecKitJob("p1", started.job.id, "u2");
    const done = await started.done; // resolves though the "model" never answered

    expect(cancelled?.status === "cancelling" || cancelled?.status === "cancelled").toBe(true);
    expect(done.status).toBe("cancelled");
    expect(done).not.toHaveProperty("result");
    expect(done).not.toHaveProperty("error");
    expect(signal?.aborted).toBe(true);
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "spec-kit",
      started.job.id,
      "p1",
      SPEC_KIT_JOB_CANCELLED_MESSAGE,
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "spec_kit.job.cancelled",
        actor: { id: "u2" },
        metadata: expect.objectContaining({ jobId: started.job.id, command: "speckit.plan" }),
      }),
    );
    // The feature is free again immediately.
    const next = await startSpecKitJob(base());
    await next.done;

    // The provider answers long after the cancel: the command must not save.
    reply.resolve("# a late plan");
    await vi.waitFor(() => expect(lateWrite).not.toBe("not attempted"));
    expect(lateWrite).toBeInstanceOf(SpecKitJobStopError);
    expect((lateWrite as SpecKitJobStopError).reason).toBe("cancelled");
    expect(written).not.toHaveBeenCalled();
    expect(fakeSpecKitJobRows.get(started.job.id)?.status).toBe("cancelled");
  });

  it("makes a stopped command's next model call fail before it is sent", async () => {
    const reply = deferred<void>();
    let nextCall: unknown = "not attempted";
    const started = await startSpecKitJob(
      base({
        run: async () => {
          await reply.promise;
          try {
            throwIfSpecKitJobStopped();
            nextCall = "sent";
          } catch (err) {
            nextCall = err;
          }
          return {};
        },
      }),
    );
    await cancelSpecKitJob("p1", started.job.id, null);
    await started.done;
    reply.resolve();
    await vi.waitFor(() => expect(nextCall).not.toBe("not attempted"));
    expect(nextCall).toBeInstanceOf(SpecKitJobStopError);
  });

  it("refuses to cancel a job that is already saving, and the job then succeeds whole", async () => {
    const saving = deferred<void>();
    const finishSaving = deferred<void>();
    const started = await startSpecKitJob(
      base({
        run: async () => {
          specKitJobCommitPoint(); // first artifact write
          saving.resolve();
          await finishSaving.promise;
          specKitJobCommitPoint(); // the rest of the set
          return { message: "Generated 5 plan artifacts" };
        },
      }),
    );
    await saving.promise;

    await expect(cancelSpecKitJob("p1", started.job.id, "u1")).rejects.toBeInstanceOf(
      SpecKitJobSavingError,
    );
    expect(fakeSpecKitJobRows.get(started.job.id)?.status).toBe("running");
    expect(auditSpy).not.toHaveBeenCalled();

    finishSaving.resolve();
    expect((await started.done).status).toBe("succeeded");
  });

  it("is idempotent on a finished job and blind to another project's job", async () => {
    const started = await startSpecKitJob(base());
    const done = await started.done;

    expect(await cancelSpecKitJob("p1", started.job.id, "u1")).toEqual(done);
    expect(await cancelSpecKitJob("p2", started.job.id, "u1")).toBeNull();
    expect(await cancelSpecKitJob("p1", "no-such-job", "u1")).toBeNull();
    expect(fakeSpecKitJobRows.get(started.job.id)?.status).toBe("succeeded");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("marks another replica's job cancelling, and that job's heartbeat stops it", async () => {
    const reply = deferred();
    // This process owns the job; the cancel arrives as another replica's would:
    // only as a change to the row.
    const started = await startSpecKitJob(base({ run: () => reply.promise, heartbeatMs: 5 }));
    await fakeSpecKitJobStore.markJobCancelling("p1", started.job.id);

    const done = await started.done;
    expect(done.status).toBe("cancelled");
    reply.resolve({});
  });

  it("marks a job this process does not run as cancelling", async () => {
    plantFakeSpecKitJob({ id: "elsewhere", activeKey: specKitJobActiveKey("p1", null) });
    const job = await cancelSpecKitJob("p1", "elsewhere", "u1");
    expect(job?.status).toBe("cancelling");
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it("settles a dead job directly instead of waiting for a heartbeat that will never come", async () => {
    plantFakeSpecKitJob({ id: "dead", heartbeatAt: longAgo() });
    const job = await cancelSpecKitJob("p1", "dead", "u1");
    expect(job).toMatchObject({ status: "failed", error: { code: "SPEC_KIT_JOB_INTERRUPTED" } });
  });
});

describe("time limit and lost ownership", () => {
  it("fails the job with SPEC_KIT_JOB_TIMEOUT and lets nothing be saved afterwards", async () => {
    const reply = deferred<void>();
    let lateWrite: unknown = "not attempted";
    const started = await startSpecKitJob(
      base({
        timeoutMs: 5,
        run: async () => {
          await reply.promise;
          try {
            specKitJobCommitPoint();
            lateWrite = "written";
          } catch (err) {
            lateWrite = err;
          }
          return {};
        },
      }),
    );
    const done = await started.done;

    expect(done).toMatchObject({
      status: "failed",
      error: { status: 504, code: "SPEC_KIT_JOB_TIMEOUT" },
    });
    expect(jobEvents.failed).toHaveBeenCalledTimes(1);
    reply.resolve();
    await vi.waitFor(() => expect(lateWrite).not.toBe("not attempted"));
    expect((lateWrite as SpecKitJobStopError).reason).toBe("timeout");
  });

  it("does not time out a job that is already saving", async () => {
    const saving = deferred<void>();
    const finish = deferred<void>();
    const started = await startSpecKitJob(
      base({
        timeoutMs: 5,
        run: async () => {
          specKitJobCommitPoint();
          saving.resolve();
          await finish.promise;
          return { message: "saved" };
        },
      }),
    );
    await saving.promise;
    // Well past the 5 ms limit; the timer has fired and been refused.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fakeSpecKitJobRows.get(started.job.id)?.status).toBe("running");
    finish.resolve();
    expect((await started.done).status).toBe("succeeded");
  });

  it("stops a job whose row was failed under it, without overwriting that outcome", async () => {
    const reply = deferred();
    const started = await startSpecKitJob(base({ run: () => reply.promise, heartbeatMs: 5 }));
    // Another replica's sweeper decided this job was dead.
    const row = fakeSpecKitJobRows.get(started.job.id)!;
    await fakeSpecKitJobStore.finishJob(
      row.id,
      { status: "failed", error: JSON.stringify({ status: 503, code: "X", message: "swept" }) },
      new Date(),
    );

    const done = await started.done;
    expect(done).toMatchObject({ status: "failed", error: { code: "X" } });
    expect(jobEvents.completed).not.toHaveBeenCalled();
    expect(jobEvents.failed).not.toHaveBeenCalled();
    reply.resolve({});
  });

  it("reads the time limit from configuration, ignoring a value out of range", () => {
    expect(resolveSpecKitJobTimeoutMs()).toBe(DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS);
    configValues.set("SPEC_KIT_JOB_TIMEOUT_MS", 600_000.7);
    expect(resolveSpecKitJobTimeoutMs()).toBe(600_000);
    for (const bad of [59_999, 21_600_001, Number.NaN, -1]) {
      configValues.set("SPEC_KIT_JOB_TIMEOUT_MS", bad);
      expect(resolveSpecKitJobTimeoutMs()).toBe(DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS);
    }
  });
});

describe("progress", () => {
  it("stores the latest phase, in order, and streams each as a progress event", async () => {
    const gate = deferred();
    const started = await startSpecKitJob(
      base({
        run: async () => {
          reportSpecKitJobPhase("Generating plan.md (1 of 5)", 10);
          reportSpecKitJobPhase("Generating research.md (2 of 5)");
          reportSpecKitJobPhase("x".repeat(500));
          await gate.promise;
          return {};
        },
      }),
    );
    await vi.waitFor(async () =>
      expect((await getSpecKitJob("p1", started.job.id))?.phase).toBe("x".repeat(200)),
    );
    expect(jobEvents.progress.mock.calls.map((c) => [c[3], c[4]])).toEqual([
      [10, "Generating plan.md (1 of 5)"],
      [50, "Generating research.md (2 of 5)"],
      [50, "x".repeat(200)],
    ]);
    gate.resolve({});
    await started.done;
  });

  it("ignores a phase reported by a command that was already stopped", async () => {
    const reply = deferred<void>();
    const reported = deferred<void>();
    const started = await startSpecKitJob(
      base({
        run: async () => {
          await reply.promise;
          reportSpecKitJobPhase("too late");
          reported.resolve();
          return {};
        },
      }),
    );
    await cancelSpecKitJob("p1", started.job.id, null);
    await started.done;
    reply.resolve();
    await reported.promise;
    expect(jobEvents.progress).not.toHaveBeenCalled();
  });

  it("is a no-op outside a job", () => {
    expect(() => {
      reportSpecKitJobPhase("nothing");
      specKitJobCommitPoint();
      throwIfSpecKitJobStopped();
    }).not.toThrow();
  });
});

describe("reading jobs — a dead job is never reported as running", () => {
  it("hides another project's job", async () => {
    const started = await startSpecKitJob(base());
    await started.done;
    expect(await getSpecKitJob("p2", started.job.id)).toBeNull();
    expect(await getSpecKitJob("p1", "no-such-job")).toBeNull();
  });

  it("fails a job whose heartbeat stopped when it is read", async () => {
    plantFakeSpecKitJob({
      id: "dead",
      activeKey: specKitJobActiveKey("p1", null),
      heartbeatAt: longAgo(),
      phase: "Generating plan.md (1 of 5)",
    });
    const job = await getSpecKitJob("p1", "dead");
    expect(job).toMatchObject({
      status: "failed",
      phase: "Generating plan.md (1 of 5)",
      error: { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED" },
    });
    expect(job?.finishedAt).not.toBeNull();
    expect(fakeSpecKitJobRows.get("dead")?.activeKey).toBeNull();
    expect(jobEvents.failed).toHaveBeenCalledWith("spec-kit", "dead", "p1", "GENERIC:spec-kit");
  });

  it("lists only live jobs of the project, oldest first", async () => {
    plantFakeSpecKitJob({ id: "b", startedAt: new Date(Date.now() - 1_000) });
    plantFakeSpecKitJob({ id: "a", startedAt: new Date(Date.now() - 2_000), status: "cancelling" });
    plantFakeSpecKitJob({ id: "dead", heartbeatAt: longAgo() });
    plantFakeSpecKitJob({ id: "done", status: "succeeded", finishedAt: new Date() });
    plantFakeSpecKitJob({ id: "other", projectId: "p2" });

    expect((await listActiveSpecKitJobs("p1")).map((j) => j.id)).toEqual(["a", "b"]);
    expect(fakeSpecKitJobRows.get("dead")?.status).toBe("failed");
  });

  it("degrades unreadable stored JSON instead of throwing", () => {
    const row = plantFakeSpecKitJob({ id: "j", status: "failed", error: "{not json" });
    expect(toSpecKitJobDto(row).error?.code).toBe("INTERNAL_ERROR");
    const ok = plantFakeSpecKitJob({ id: "k", status: "succeeded", result: "{not json" });
    expect(toSpecKitJobDto(ok).result).toBeNull();
  });
});

describe("restart recovery — the sweeper", () => {
  it("fails stale running jobs, cancels stale cancelling ones, and spares live ones", async () => {
    plantFakeSpecKitJob({ id: "dead", heartbeatAt: longAgo(), activeKey: "p1:a" });
    plantFakeSpecKitJob({
      id: "dead-cancelling",
      status: "cancelling",
      heartbeatAt: longAgo(),
      activeKey: "p1:b",
    });
    plantFakeSpecKitJob({ id: "alive", activeKey: "p1:c" });

    expect(await failInterruptedSpecKitJobs()).toBe(2);

    expect(fakeSpecKitJobRows.get("dead")).toMatchObject({ status: "failed", activeKey: null });
    expect(JSON.parse(fakeSpecKitJobRows.get("dead")!.error!)).toMatchObject({
      status: 503,
      code: "SPEC_KIT_JOB_INTERRUPTED",
    });
    expect(fakeSpecKitJobRows.get("dead-cancelling")).toMatchObject({
      status: "cancelled",
      activeKey: null,
      error: null,
    });
    expect(fakeSpecKitJobRows.get("alive")).toMatchObject({
      status: "running",
      activeKey: "p1:c",
    });
    expect(jobEvents.failed).toHaveBeenCalledTimes(1);
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "spec-kit",
      "dead-cancelling",
      "p1",
      SPEC_KIT_JOB_CANCELLED_MESSAGE,
    );
    // A second pass finds nothing left to fail.
    expect(await failInterruptedSpecKitJobs()).toBe(0);
  });

  it("spares a job that heartbeats between the sweep's read and its write", async () => {
    const row = plantFakeSpecKitJob({ id: "slow", heartbeatAt: longAgo() });
    const find = vi.spyOn(fakeSpecKitJobStore, "findStaleJobs").mockImplementationOnce(async () => {
      const read = [{ ...row }];
      fakeSpecKitJobRows.get("slow")!.heartbeatAt = new Date(); // it beat just now
      return read;
    });
    expect(await failInterruptedSpecKitJobs()).toBe(0);
    find.mockRestore();
    expect(fakeSpecKitJobRows.get("slow")?.status).toBe("running");
  });

  it("stops this process's own job when it is swept as stalled", async () => {
    const reply = deferred();
    const started = await startSpecKitJob(base({ run: () => reply.promise }));
    fakeSpecKitJobRows.get(started.job.id)!.heartbeatAt = longAgo();

    expect(await failInterruptedSpecKitJobs()).toBe(1);
    const done = await started.done;
    expect(done).toMatchObject({ status: "failed", error: { code: "SPEC_KIT_JOB_INTERRUPTED" } });
    reply.resolve({});
  });

  it("prunes jobs that finished more than the retention ago, and only those", async () => {
    const old = new Date(Date.now() - SPEC_KIT_JOB_RETENTION_MS - 60_000);
    plantFakeSpecKitJob({ id: "old", status: "succeeded", finishedAt: old });
    plantFakeSpecKitJob({ id: "recent", status: "failed", finishedAt: new Date() });
    plantFakeSpecKitJob({ id: "alive" });

    await failInterruptedSpecKitJobs();
    expect([...fakeSpecKitJobRows.keys()].sort()).toEqual(["alive", "recent"]);
  });

  it("sweeps at startup and then on its interval, until stopped", async () => {
    vi.useFakeTimers();
    try {
      const find = vi.spyOn(fakeSpecKitJobStore, "findStaleJobs");
      const stop = startSpecKitJobSweeper(1_000);
      expect(find).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(find).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(find).toHaveBeenCalledTimes(3);
      find.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a sweep that throws", async () => {
    vi.useFakeTimers();
    try {
      const find = vi
        .spyOn(fakeSpecKitJobStore, "findStaleJobs")
        .mockRejectedValue(new Error("db down"));
      const stop = startSpecKitJobSweeper(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(find).toHaveBeenCalledTimes(2);
      stop();
      find.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("extractCompletionMessage", () => {
  it("returns the result's message, or the fallback", () => {
    expect(extractCompletionMessage({ message: "Generated spec.md (v3)." }, "fb")).toBe(
      "Generated spec.md (v3).",
    );
    for (const none of [{}, null, { message: "" }, { message: 7 }, "text"]) {
      expect(extractCompletionMessage(none, "fb")).toBe("fb");
    }
  });
});
