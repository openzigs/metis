/**
 * #1059 — the Spec Kit job runner's rules (`src/lib/spec-kit/jobs.ts`), written
 * once against a {@link SpecKitJobTable} and run on BOTH stores:
 *
 *   - the in-memory fake — `spec-kit-jobs-1059.test.ts`;
 *   - the REAL store on a real SQLite database — `spec-kit-job-rules-1059.sqlite.test.ts`.
 *
 * So every race below (a cancel against a save, the time limit against a save,
 * a sweep against the owner, a row failed by another replica) is decided by the
 * real store's own UPDATE statements, not by a re-implementation of them. The
 * statements themselves, on SQLite and on Postgres, are held to
 * `spec-kit-job-store-contract.ts`.
 *
 * Every wait here is on an event (a deferred the test controls, or a state the
 * test polls for with a generous ceiling). Nothing asserts that something took
 * less than a wall-clock figure: CI is several times slower than a laptop.
 *
 * The including test file declares the module mocks (see
 * `spec-kit-job-rules-mocks.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS,
  SPEC_KIT_JOB_CANCELLED_MESSAGE,
  SPEC_KIT_JOB_INTERRUPTED_ERROR,
  SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR,
  SPEC_KIT_JOB_RETENTION_MS,
  SPEC_KIT_JOB_STALE_MS,
  SPEC_KIT_JOB_UNRECORDED_ERROR,
  SpecKitJobConflictError,
  SpecKitJobSavingError,
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
} from "../../src/lib/spec-kit/jobs.js";
import * as jobsModule from "../../src/lib/spec-kit/jobs.js";
import {
  SpecKitJobStopError,
  currentSpecKitJob,
  reportSpecKitJobPhase,
  specKitJobCommitPoint,
  throwIfSpecKitJobStopped,
} from "../../src/lib/spec-kit/job-scope.js";
import { auditSpy, configValues, jobEvents, recordJobScope } from "./spec-kit-job-rules-mocks.js";
import type { SpecKitJobTable } from "./spec-kit-job-table.js";
import { stopLiveSpecKitJobs } from "./spec-kit-jobs-reset.js";

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

const P1 = "p1";
const P2 = "p2";
const PROJECTS = [P1, P2];
const SLUG = "001-mark-read";
/** Far above what any step here needs, far below the test timeout. */
const WAIT = { timeout: 8_000, interval: 5 };
/** The wall clock, read where a faked `Date` cannot reach it. */
const realNow = (): number => performance.timeOrigin + performance.now();
/** A heartbeat older than the stale threshold by a wide margin. */
const longAgo = (): Date => new Date(realNow() - SPEC_KIT_JOB_STALE_MS * 10);

const base = (over: Partial<StartSpecKitJobInput> = {}): StartSpecKitJobInput => ({
  projectId: P1,
  command: "speckit.plan",
  featureSlug: SLUG,
  actorId: "u1",
  run: async () => ({ message: "done" }),
  // No test here waits out a real retry delay.
  outcomeRetryMs: [1, 1],
  ...over,
});

export function defineSpecKitJobRules(table: () => SpecKitJobTable): void {
  const store = () => table().store;
  const rowOf = async (id: string) => {
    const found = await table().get(id);
    if (!found) throw new Error(`no row ${id}`);
    return found;
  };
  const errorOf = async (id: string) => JSON.parse((await rowOf(id)).error ?? "null");

  beforeEach(async () => {
    vi.clearAllMocks();
    configValues.clear();
    await table().reset(PROJECTS);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stopLiveSpecKitJobs();
    await table().reset(PROJECTS);
  });

  it("exports no switch that stops every live job", () => {
    expect(Object.keys(jobsModule).filter((name) => /reset|^_/i.test(name))).toEqual([]);
  });

  describe("startSpecKitJob — the command runs after the start returns", () => {
    it("returns a running job while the command is still waiting, then stores its result", async () => {
      const gate = deferred<{ message: string; artifacts: string[] }>();
      const started = await startSpecKitJob(base({ run: () => gate.promise }));

      expect(started.job).toMatchObject({
        projectId: P1,
        command: "speckit.plan",
        featureSlug: SLUG,
        status: "running",
        startedById: "u1",
        finishedAt: null,
      });
      expect(started.job).not.toHaveProperty("result");
      expect(await getSpecKitJob(P1, started.job.id)).toMatchObject({ status: "running" });
      expect(liveSpecKitJobCount()).toBe(1);

      gate.resolve({ message: "Generated 5 plan artifacts", artifacts: ["plan.md"] });
      const done = await started.done;

      expect(done.status).toBe("succeeded");
      expect(done.result).toEqual({
        message: "Generated 5 plan artifacts",
        artifacts: ["plan.md"],
      });
      expect(done.finishedAt).not.toBeNull();
      expect(liveSpecKitJobCount()).toBe(0);
      // The stored job is what a later poll reads.
      expect(await getSpecKitJob(P1, started.job.id)).toEqual(done);
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
      expect(recordJobScope).toHaveBeenCalledWith(started.job.id, "spec-kit", P1);
      expect(jobEvents.started).toHaveBeenCalledWith(
        "spec-kit",
        started.job.id,
        P1,
        "Running /plan",
      );
      // #423 — the grounded-completion line is the terminal message, verbatim.
      expect(jobEvents.completed).toHaveBeenCalledWith(
        "spec-kit",
        started.job.id,
        P1,
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
        P1,
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

    it("leaves no row behind, and the feature free, when the job's scope cannot be recorded", async () => {
      recordJobScope.mockRejectedValueOnce(new Error("scope store is down"));
      const run = vi.fn(async () => ({}));

      await expect(startSpecKitJob(base({ run }))).rejects.toThrow("scope store is down");

      // Not a `running` row with no runner, holding the feature until a sweep.
      expect(await table().ids(PROJECTS)).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      expect(liveSpecKitJobCount()).toBe(0);
      await expect(startSpecKitJob(base())).resolves.toBeTruthy();
    });

    it("retries removing that row when the first attempt fails", async () => {
      recordJobScope.mockRejectedValueOnce(new Error("scope store is down"));
      const discard = vi
        .spyOn(store(), "discardJob")
        .mockRejectedValueOnce(new Error("database is locked"));

      await expect(startSpecKitJob(base())).rejects.toThrow("scope store is down");

      expect(discard).toHaveBeenCalledTimes(2);
      expect(await table().ids(PROJECTS)).toEqual([]);
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
        P1,
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
      expect(JSON.stringify(await rowOf(started.job.id))).not.toContain("postgres://");
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
  });

  describe("storing the outcome — retried, and truthful when it cannot be stored", () => {
    it("stores the outcome on a later attempt when the first write fails", async () => {
      const finish = vi
        .spyOn(store(), "finishJob")
        .mockRejectedValueOnce(new Error("database is locked"));
      const started = await startSpecKitJob(
        base({ run: async () => ({ message: "Generated plan.md (v2)." }) }),
      );
      const done = await started.done;

      expect(finish.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(done.status).toBe("succeeded");
      expect(await rowOf(started.job.id)).toMatchObject({ status: "succeeded", activeKey: null });
      expect(jobEvents.completed).toHaveBeenCalledTimes(1);
      // The feature is free at once, not after a sweep.
      await expect(startSpecKitJob(base())).resolves.toBeTruthy();
    });

    it("gives up after three attempts", async () => {
      const finish = vi.spyOn(store(), "finishJob").mockRejectedValue(new Error("db down"));
      const started = await startSpecKitJob(base());
      await started.done;
      expect(finish).toHaveBeenCalledTimes(3);
    });

    it("does not claim nothing was saved for a command that saved and could not be recorded", async () => {
      vi.spyOn(store(), "finishJob").mockRejectedValue(new Error("db down"));
      const started = await startSpecKitJob(
        base({
          run: async () => {
            await specKitJobCommitPoint(); // the artifacts are written from here
            return { message: "Generated plan.md (v2)." };
          },
        }),
      );
      const done = await started.done;

      expect(done.status).toBe("failed");
      expect(done.error).toEqual(SPEC_KIT_JOB_UNRECORDED_ERROR);
      expect(done.error?.message).toContain("may have been saved");
      expect(done.error?.message).not.toMatch(/nothing/i);
      expect(jobEvents.completed).not.toHaveBeenCalled();

      // The row is left `saving` with no heartbeat; the sweep that fails it
      // says the same thing.
      vi.restoreAllMocks();
      expect((await rowOf(started.job.id)).status).toBe("saving");
      await table().patch(started.job.id, { heartbeatAt: longAgo() });
      expect(await failInterruptedSpecKitJobs()).toBe(1);
      expect(await errorOf(started.job.id)).toEqual(SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR);
      expect(SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR.message).toContain("may have been saved");
      expect(SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR.message).not.toMatch(/nothing/i);
    });

    it("says nothing was saved only for a command that never began to save", async () => {
      vi.spyOn(store(), "finishJob").mockRejectedValue(new Error("db down"));
      const started = await startSpecKitJob(base({ run: async () => ({}) }));
      const done = await started.done;

      expect(done.error).toEqual(SPEC_KIT_JOB_INTERRUPTED_ERROR);
      vi.restoreAllMocks();
      expect((await rowOf(started.job.id)).status).toBe("running");
      await table().patch(started.job.id, { heartbeatAt: longAgo() });
      await failInterruptedSpecKitJobs();
      expect(await errorOf(started.job.id)).toEqual(SPEC_KIT_JOB_INTERRUPTED_ERROR);
    });
  });

  describe("duplicate start — never two jobs on one artifact set", () => {
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
      expect(await table().ids(PROJECTS)).toEqual([first.job.id]);
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
        await startSpecKitJob(base({ run, projectId: P2 })),
      ];
      expect(new Set(jobs.map((j) => j.job.id)).size).toBe(4);
      expect(specKitJobActiveKey(P1, null)).not.toBe(specKitJobActiveKey(P1, SLUG));
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
        expect((await rowOf(job.job.id)).activeKey).toBeNull();
      }
      await expect(startSpecKitJob(base())).resolves.toBeTruthy();
    });

    it("takes over a feature whose job has no live process, failing that job as interrupted", async () => {
      await table().plant({
        id: "dead",
        featureSlug: SLUG,
        activeKey: specKitJobActiveKey(P1, SLUG),
        heartbeatAt: longAgo(),
      });

      const started = await startSpecKitJob(base());
      await started.done;

      expect(started.job.id).not.toBe("dead");
      expect(await getSpecKitJob(P1, "dead")).toMatchObject({
        status: "failed",
        error: { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED" },
      });
    });

    it("does not take over a job whose heartbeat is fresh", async () => {
      await table().plant({
        id: "alive",
        featureSlug: SLUG,
        activeKey: specKitJobActiveKey(P1, SLUG),
      });
      await expect(startSpecKitJob(base())).rejects.toBeInstanceOf(SpecKitJobConflictError);
      expect((await rowOf("alive")).status).toBe("running");
    });

    it("fails only the dead holder of ITS key, not every dead job, on the way in", async () => {
      await table().plant({
        id: "dead-elsewhere",
        featureSlug: "009-elsewhere",
        activeKey: specKitJobActiveKey(P1, "009-elsewhere"),
        heartbeatAt: longAgo(),
      });
      await table().plant({
        id: "holder",
        featureSlug: SLUG,
        activeKey: specKitJobActiveKey(P1, SLUG),
      });
      await expect(startSpecKitJob(base())).rejects.toBeInstanceOf(SpecKitJobConflictError);
      expect((await rowOf("dead-elsewhere")).status).toBe("running");
    });
  });

  describe("the commit point — the DATABASE decides whether a job may write", () => {
    it("moves the row to saving at the first write, and keeps it there for the rest", async () => {
      const afterFirst = deferred<void>();
      const goOn = deferred<void>();
      const started = await startSpecKitJob(
        base({
          run: async () => {
            await specKitJobCommitPoint();
            afterFirst.resolve();
            await goOn.promise;
            await specKitJobCommitPoint();
            await specKitJobCommitPoint();
            return {};
          },
        }),
      );
      await afterFirst.promise;
      expect(await getSpecKitJob(P1, started.job.id)).toMatchObject({ status: "saving" });
      expect((await listActiveSpecKitJobs(P1)).map((j) => j.status)).toEqual(["saving"]);
      // Still one writer: the key is held while saving.
      await expect(startSpecKitJob(base())).rejects.toBeInstanceOf(SpecKitJobConflictError);

      goOn.resolve();
      expect((await started.done).status).toBe("succeeded");
    });

    it("makes one transition for several first writes issued together", async () => {
      const begin = vi.spyOn(store(), "beginSaving");
      const started = await startSpecKitJob(
        base({
          run: async () => {
            await Promise.all([
              specKitJobCommitPoint(),
              specKitJobCommitPoint(),
              specKitJobCommitPoint(),
            ]);
            return {};
          },
        }),
      );
      expect((await started.done).status).toBe("succeeded");
      expect(begin).toHaveBeenCalledTimes(1);
    });

    // The reviewer's probe P1: the row is failed by another replica (its
    // sweep), which this process is not told about. Nothing in memory says the
    // job has lost its row; only the database does.
    it("refuses a job whose row another replica failed: it writes nothing and leaves that row alone", async () => {
      const reply = deferred<void>();
      const written = vi.fn();
      let refusal: unknown = "not attempted";
      // A heartbeat that never fires during the test: no beat tells the owner.
      const first = await startSpecKitJob(
        base({
          heartbeatMs: 3_600_000,
          run: async () => {
            await reply.promise; // the model call in flight
            try {
              await specKitJobCommitPoint();
              written();
            } catch (err) {
              refusal = err;
              throw err;
            }
            return { message: "saved" };
          },
        }),
      );
      // Exactly the update another replica's sweep makes.
      const swept = { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED", message: "swept elsewhere" };
      await table().patch(first.job.id, {
        status: "failed",
        activeKey: null,
        finishedAt: new Date(),
        error: JSON.stringify(swept),
      });
      // The key is free, so a second job on the same feature is accepted…
      const second = await startSpecKitJob(base({ run: async () => ({ message: "second" }) }));
      await second.done;

      // …and the first job's model call now answers.
      reply.resolve();
      const done = await first.done;

      expect(written).not.toHaveBeenCalled();
      expect(refusal).toBeInstanceOf(SpecKitJobStopError);
      expect((refusal as SpecKitJobStopError).reason).toBe("superseded");
      // The row it no longer owns is exactly as the other replica left it.
      expect(done).toMatchObject({ status: "failed", error: swept });
      expect(await errorOf(first.job.id)).toEqual(swept);
      expect((await rowOf(second.job.id)).status).toBe("succeeded");
      // It announced nothing: the replica that failed the row already did.
      expect(jobEvents.completed).toHaveBeenCalledTimes(1);
      expect(jobEvents.completed.mock.calls[0]?.[1]).toBe(second.job.id);
      expect(jobEvents.failed).not.toHaveBeenCalled();
    });

    // The owner is not told (no heartbeat fires) and its command never reaches
    // a commit point, so the only thing between it and the other replica's
    // outcome is the condition on its own terminal write.
    it.each([
      ["succeeds without writing", async () => ({ message: "an answer nobody saved" })],
      [
        "fails",
        async () => {
          throw new Error("the model call failed");
        },
      ],
    ])(
      "does not overwrite a row another replica already failed when its command then %s",
      async (_how, finish) => {
        const reply = deferred<void>();
        const started = await startSpecKitJob(
          base({
            heartbeatMs: 3_600_000,
            run: async () => {
              await reply.promise;
              return finish();
            },
            mapError: () => ({ status: 502, code: "LATE", message: "a late failure" }),
          }),
        );
        const swept = { status: 503, code: "SPEC_KIT_JOB_INTERRUPTED", message: "swept elsewhere" };
        const finishedAt = new Date(realNow() - 5_000);
        await table().patch(started.job.id, {
          status: "failed",
          activeKey: null,
          finishedAt,
          error: JSON.stringify(swept),
        });

        reply.resolve();
        const done = await started.done;

        expect(done).toMatchObject({ status: "failed", error: swept });
        expect(done).not.toHaveProperty("result");
        const row = await rowOf(started.job.id);
        expect(row).toMatchObject({ status: "failed", result: null, activeKey: null });
        expect(JSON.parse(row.error ?? "null")).toEqual(swept);
        expect(row.finishedAt?.getTime()).toBe(finishedAt.getTime());
        // It announced nothing either: the replica that closed the row did.
        expect(jobEvents.completed).not.toHaveBeenCalled();
        expect(jobEvents.failed).not.toHaveBeenCalled();
      },
    );

    it("refuses a job whose row still runs but no longer holds its key", async () => {
      const reply = deferred<void>();
      const written = vi.fn();
      const started = await startSpecKitJob(
        base({
          heartbeatMs: 3_600_000,
          run: async () => {
            await reply.promise;
            await specKitJobCommitPoint();
            written();
            return {};
          },
        }),
      );
      await table().patch(started.job.id, { activeKey: specKitJobActiveKey(P1, "taken-away") });
      reply.resolve();
      await started.done;
      expect(written).not.toHaveBeenCalled();
      expect((await rowOf(started.job.id)).status).toBe("running");
    });

    it("refuses a job whose row was deleted", async () => {
      const reply = deferred<void>();
      const written = vi.fn();
      const started = await startSpecKitJob(
        base({
          heartbeatMs: 3_600_000,
          run: async () => {
            await reply.promise;
            await specKitJobCommitPoint();
            written();
            return {};
          },
        }),
      );
      await table().reset(PROJECTS);
      reply.resolve();
      const done = await started.done;
      expect(written).not.toHaveBeenCalled();
      // No row to read back: the caller is told it was interrupted before saving.
      expect(done).toMatchObject({ status: "failed", error: SPEC_KIT_JOB_INTERRUPTED_ERROR });
    });

    it("stops a job that is ALREADY saving when its row is swept, at its next write", async () => {
      const afterFirst = deferred<void>();
      const goOn = deferred<void>();
      const secondWrite = vi.fn();
      let refusal: unknown = "not attempted";
      const started = await startSpecKitJob(
        base({
          heartbeatMs: 3_600_000,
          run: async () => {
            await specKitJobCommitPoint(); // artifact 1 of 5 is written
            afterFirst.resolve();
            await goOn.promise;
            try {
              await specKitJobCommitPoint(); // artifact 2 of 5
              secondWrite();
            } catch (err) {
              refusal = err;
              throw err;
            }
            return {};
          },
        }),
      );
      await afterFirst.promise;
      // The owner stalled (or its heartbeat writes failed) for the whole
      // threshold, and the sweep of THIS process fails the row.
      await table().patch(started.job.id, { heartbeatAt: longAgo() });
      expect(await failInterruptedSpecKitJobs()).toBe(1);
      const done = await started.done;

      // The row says what is true: it was saving, so it may be part-saved.
      expect(done).toMatchObject({
        status: "failed",
        error: SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR,
      });
      goOn.resolve();
      await vi.waitFor(() => expect(refusal).not.toBe("not attempted"), WAIT);
      expect(secondWrite).not.toHaveBeenCalled();
      expect((refusal as SpecKitJobStopError).reason).toBe("superseded");
    });

    it("stops a saving job whose row ANOTHER replica swept, at its next write", async () => {
      const afterFirst = deferred<void>();
      const goOn = deferred<void>();
      const secondWrite = vi.fn();
      const started = await startSpecKitJob(
        base({
          heartbeatMs: 3_600_000,
          run: async () => {
            await specKitJobCommitPoint();
            afterFirst.resolve();
            await goOn.promise;
            await specKitJobCommitPoint();
            secondWrite();
            return {};
          },
        }),
      );
      await afterFirst.promise;
      await table().patch(started.job.id, {
        status: "failed",
        activeKey: null,
        error: JSON.stringify(SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR),
        finishedAt: new Date(),
      });
      goOn.resolve();
      const done = await started.done;

      expect(secondWrite).not.toHaveBeenCalled();
      expect(done).toMatchObject({
        status: "failed",
        error: SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR,
      });
      expect(jobEvents.completed).not.toHaveBeenCalled();
    });

    it("is a no-op outside a job", async () => {
      expect(() => {
        reportSpecKitJobPhase("nothing");
        throwIfSpecKitJobStopped();
      }).not.toThrow();
      await expect(specKitJobCommitPoint()).resolves.toBeUndefined();
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
              await specKitJobCommitPoint();
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

      const cancelled = await cancelSpecKitJob(P1, started.job.id, "u2");
      const done = await started.done; // resolves though the "model" never answered

      expect(cancelled?.status === "cancelling" || cancelled?.status === "cancelled").toBe(true);
      expect(done.status).toBe("cancelled");
      expect(done).not.toHaveProperty("result");
      expect(done).not.toHaveProperty("error");
      expect(signal?.aborted).toBe(true);
      expect(jobEvents.completed).toHaveBeenCalledWith(
        "spec-kit",
        started.job.id,
        P1,
        SPEC_KIT_JOB_CANCELLED_MESSAGE,
      );
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "spec_kit.job.cancelled",
          actor: { id: "u2" },
          metadata: expect.objectContaining({
            jobId: started.job.id,
            command: "speckit.plan",
            // Whose job it was: any member with project.update may cancel it.
            startedById: "u1",
          }),
        }),
      );
      // The feature is free again immediately.
      const next = await startSpecKitJob(base());
      await next.done;

      // The provider answers long after the cancel: the command must not save.
      reply.resolve("# a late plan");
      await vi.waitFor(() => expect(lateWrite).not.toBe("not attempted"), WAIT);
      expect(lateWrite).toBeInstanceOf(SpecKitJobStopError);
      expect((lateWrite as SpecKitJobStopError).reason).toBe("cancelled");
      expect(written).not.toHaveBeenCalled();
      expect((await rowOf(started.job.id)).status).toBe("cancelled");
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
      await cancelSpecKitJob(P1, started.job.id, null);
      await started.done;
      reply.resolve();
      await vi.waitFor(() => expect(nextCall).not.toBe("not attempted"), WAIT);
      expect(nextCall).toBeInstanceOf(SpecKitJobStopError);
    });

    it("refuses to cancel a job that is already saving, and the job then succeeds whole", async () => {
      const saving = deferred<void>();
      const finishSaving = deferred<void>();
      const started = await startSpecKitJob(
        base({
          run: async () => {
            await specKitJobCommitPoint(); // first artifact write
            saving.resolve();
            await finishSaving.promise;
            await specKitJobCommitPoint(); // the rest of the set
            return { message: "Generated 5 plan artifacts" };
          },
        }),
      );
      await saving.promise;

      await expect(cancelSpecKitJob(P1, started.job.id, "u1")).rejects.toBeInstanceOf(
        SpecKitJobSavingError,
      );
      expect((await rowOf(started.job.id)).status).toBe("saving");
      expect(auditSpy).not.toHaveBeenCalled();

      finishSaving.resolve();
      expect((await started.done).status).toBe("succeeded");
    });

    // The cross-replica half of the same rule: this process does not run the
    // job, so all it can see is the row.
    it("refuses to cancel ANOTHER replica's job that is already saving, and audits nothing", async () => {
      await table().plant({
        id: "elsewhere",
        status: "saving",
        activeKey: specKitJobActiveKey(P1, null),
      });

      await expect(cancelSpecKitJob(P1, "elsewhere", "u1")).rejects.toBeInstanceOf(
        SpecKitJobSavingError,
      );

      // Not `cancelling` followed by a success.
      expect((await rowOf("elsewhere")).status).toBe("saving");
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("lets a cancel from another replica win at the commit point, before any heartbeat", async () => {
      const reply = deferred<void>();
      const written = vi.fn();
      const started = await startSpecKitJob(
        base({
          heartbeatMs: 3_600_000, // nothing but the commit point can notice
          run: async () => {
            await reply.promise;
            await specKitJobCommitPoint();
            written();
            return { message: "saved" };
          },
        }),
      );
      // The cancel arrives as another replica's would: only as a change to the row.
      expect(await store().markJobCancelling(P1, started.job.id)).toBe(true);
      reply.resolve();
      const done = await started.done;

      expect(written).not.toHaveBeenCalled();
      expect(done.status).toBe("cancelled");
      expect(done).not.toHaveProperty("result");
    });

    it("ends as cancelled a command that finished without a write after a cancel won its row", async () => {
      const reply = deferred<unknown>();
      const started = await startSpecKitJob(
        base({ heartbeatMs: 3_600_000, run: () => reply.promise }),
      );
      await store().markJobCancelling(P1, started.job.id);
      reply.resolve({ message: "an answer nobody saved" });
      const done = await started.done;

      // The cancel was answered "cancelling": it is not followed by a success.
      expect(done.status).toBe("cancelled");
      expect(done).not.toHaveProperty("result");
      expect(jobEvents.completed).toHaveBeenCalledWith(
        "spec-kit",
        started.job.id,
        P1,
        SPEC_KIT_JOB_CANCELLED_MESSAGE,
      );
    });

    it("is idempotent on a finished job and blind to another project's job", async () => {
      const started = await startSpecKitJob(base());
      const done = await started.done;

      expect(await cancelSpecKitJob(P1, started.job.id, "u1")).toEqual(done);
      expect(await cancelSpecKitJob(P2, started.job.id, "u1")).toBeNull();
      expect(await cancelSpecKitJob(P1, "no-such-job", "u1")).toBeNull();
      expect((await rowOf(started.job.id)).status).toBe("succeeded");
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("audits nothing when the job finished between the read and the cancel", async () => {
      const gate = deferred();
      const started = await startSpecKitJob(base({ run: () => gate.promise }));
      const real = store().markJobCancelling;
      vi.spyOn(store(), "markJobCancelling").mockImplementationOnce(async (projectId, id) => {
        gate.resolve({ message: "finished first" });
        await started.done;
        return real(projectId, id);
      });

      const job = await cancelSpecKitJob(P1, started.job.id, "u2");

      expect(job?.status).toBe("succeeded");
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("audits a cancel once, not once per click", async () => {
      await table().plant({ id: "elsewhere", activeKey: specKitJobActiveKey(P1, null) });
      expect((await cancelSpecKitJob(P1, "elsewhere", "u1"))?.status).toBe("cancelling");
      expect((await cancelSpecKitJob(P1, "elsewhere", "u2"))?.status).toBe("cancelling");
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0]?.[0]).toMatchObject({ actor: { id: "u1" } });
    });

    it("marks another replica's job cancelling, and that job's heartbeat stops it", async () => {
      const reply = deferred();
      // This process owns the job; the cancel arrives as another replica's would:
      // only as a change to the row.
      const started = await startSpecKitJob(base({ run: () => reply.promise, heartbeatMs: 5 }));
      await store().markJobCancelling(P1, started.job.id);

      const done = await started.done;
      expect(done.status).toBe("cancelled");
      reply.resolve({});
    });

    it("settles a dead job directly instead of waiting for a heartbeat that will never come", async () => {
      await table().plant({ id: "dead", heartbeatAt: longAgo() });
      const job = await cancelSpecKitJob(P1, "dead", "u1");
      expect(job).toMatchObject({ status: "failed", error: { code: "SPEC_KIT_JOB_INTERRUPTED" } });
      // Nothing was cancelled, so nothing says so.
      expect(auditSpy).not.toHaveBeenCalled();
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
              await specKitJobCommitPoint();
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
      expect(await rowOf(started.job.id)).toMatchObject({ status: "failed", activeKey: null });
      expect(jobEvents.failed).toHaveBeenCalledTimes(1);
      reply.resolve();
      await vi.waitFor(() => expect(lateWrite).not.toBe("not attempted"), WAIT);
      expect((lateWrite as SpecKitJobStopError).reason).toBe("timeout");
    });

    // The time limit's timer is the only thing faked in the next two tests, so
    // WHEN it fires is the test's decision and not a race with the database.
    const TIME_LIMIT_MS = 60_000;
    /** Resolves once the time limit has tried to take the row, with whether it won. */
    const watchTimeLimit = (): Promise<boolean> => {
      const tried = deferred<boolean>();
      const realFinish = store().finishJob;
      vi.spyOn(store(), "finishJob").mockImplementation(async (id, outcome, from) => {
        const won = await realFinish(id, outcome, from);
        if (outcome.error?.includes("SPEC_KIT_JOB_TIMEOUT")) tried.resolve(won);
        return won;
      });
      return tried.promise;
    };

    it("does not time out a job that is already saving", async () => {
      const saving = deferred<void>();
      const finish = deferred<void>();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const started = await startSpecKitJob(
        base({
          timeoutMs: TIME_LIMIT_MS,
          run: async () => {
            await specKitJobCommitPoint();
            saving.resolve();
            await finish.promise;
            return { message: "saved" };
          },
        }),
      );
      await saving.promise;
      const timeLimit = watchTimeLimit();

      vi.advanceTimersByTime(TIME_LIMIT_MS);

      // The time limit fired and was refused by the row.
      expect(await timeLimit).toBe(false);
      expect((await rowOf(started.job.id)).status).toBe("saving");
      finish.resolve();
      expect((await started.done).status).toBe("succeeded");
      expect(jobEvents.failed).not.toHaveBeenCalled();
    });

    it("leaves a job somebody is cancelling to be cancelled, not timed out", async () => {
      const reply = deferred();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const started = await startSpecKitJob(
        base({ timeoutMs: TIME_LIMIT_MS, heartbeatMs: 3_600_000, run: () => reply.promise }),
      );
      await store().markJobCancelling(P1, started.job.id);
      const timeLimit = watchTimeLimit();

      vi.advanceTimersByTime(TIME_LIMIT_MS);

      expect(await timeLimit).toBe(false);
      expect((await rowOf(started.job.id)).status).toBe("cancelling");
      reply.resolve({});
      expect((await started.done).status).toBe("cancelled");
    });

    it("applies the time limit on a later attempt when its first write fails", async () => {
      const reply = deferred();
      vi.spyOn(store(), "finishJob").mockRejectedValueOnce(new Error("database is locked"));
      const started = await startSpecKitJob(
        base({ timeoutMs: 5, heartbeatMs: 10, run: () => reply.promise }),
      );
      const done = await started.done;
      expect(done.error?.code).toBe("SPEC_KIT_JOB_TIMEOUT");
      reply.resolve({});
    });

    it("stops a job whose row was failed under it, without overwriting that outcome", async () => {
      const reply = deferred();
      const started = await startSpecKitJob(base({ run: () => reply.promise, heartbeatMs: 5 }));
      // Another replica's sweeper decided this job was dead.
      await store().finishJob(
        started.job.id,
        { status: "failed", error: JSON.stringify({ status: 503, code: "X", message: "swept" }) },
        ["running"],
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

  describe("a finished job holds no timer", () => {
    // Odd values, so each timer is recognisable among whatever else is set.
    const HEARTBEAT_MS = 54_321;
    const TIMEOUT_MS = 65_432;

    it.each([
      ["succeeds", async () => ({ message: "ok" })],
      [
        "fails",
        async () => {
          throw new Error("boom");
        },
      ],
    ])("releases its heartbeat and its time limit when it %s", async (_name, run) => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const started = await startSpecKitJob(
        base({ heartbeatMs: HEARTBEAT_MS, timeoutMs: TIMEOUT_MS, run }),
      );
      await started.done;

      const handleOf = (spy: typeof setIntervalSpy | typeof setTimeoutSpy, delay: number) => {
        const index = spy.mock.calls.findIndex((call) => call[1] === delay);
        expect(index).toBeGreaterThanOrEqual(0);
        return spy.mock.results[index]?.value as unknown;
      };
      expect(clearIntervalSpy).toHaveBeenCalledWith(handleOf(setIntervalSpy, HEARTBEAT_MS));
      expect(clearTimeoutSpy).toHaveBeenCalledWith(handleOf(setTimeoutSpy, TIMEOUT_MS));
    });

    it("releases them when it is cancelled", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const reply = deferred();
      const started = await startSpecKitJob(
        base({ heartbeatMs: HEARTBEAT_MS, run: () => reply.promise }),
      );
      await cancelSpecKitJob(P1, started.job.id, "u1");
      await started.done;

      const index = setIntervalSpy.mock.calls.findIndex((call) => call[1] === HEARTBEAT_MS);
      expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[index]?.value);
      reply.resolve({});
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
      await vi.waitFor(
        async () => expect((await getSpecKitJob(P1, started.job.id))?.phase).toBe("x".repeat(200)),
        WAIT,
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
      await cancelSpecKitJob(P1, started.job.id, null);
      await started.done;
      reply.resolve();
      await reported.promise;
      expect(jobEvents.progress).not.toHaveBeenCalled();
    });
  });

  describe("reading jobs — a dead job is never reported as running", () => {
    it("hides another project's job", async () => {
      const started = await startSpecKitJob(base());
      await started.done;
      expect(await getSpecKitJob(P2, started.job.id)).toBeNull();
      expect(await getSpecKitJob(P1, "no-such-job")).toBeNull();
    });

    it("does not fail a dead job on a read through ANOTHER project", async () => {
      await table().plant({ id: "dead", heartbeatAt: longAgo() });
      expect(await getSpecKitJob(P2, "dead")).toBeNull();
      expect(await listActiveSpecKitJobs(P2)).toEqual([]);
      expect(await cancelSpecKitJob(P2, "dead", "u1")).toBeNull();
      expect((await rowOf("dead")).status).toBe("running");
    });

    it("fails a job whose heartbeat stopped when it is read", async () => {
      await table().plant({
        id: "dead",
        activeKey: specKitJobActiveKey(P1, null),
        heartbeatAt: longAgo(),
        phase: "Generating plan.md (1 of 5)",
      });
      const job = await getSpecKitJob(P1, "dead");
      expect(job).toMatchObject({
        status: "failed",
        phase: "Generating plan.md (1 of 5)",
        error: SPEC_KIT_JOB_INTERRUPTED_ERROR,
      });
      expect(job?.error?.message).toContain("before it saved anything");
      expect(job?.finishedAt).not.toBeNull();
      expect((await rowOf("dead")).activeKey).toBeNull();
      expect(jobEvents.failed).toHaveBeenCalledWith("spec-kit", "dead", P1, "GENERIC:spec-kit");
    });

    it("fails only the job that was read, not the project's other dead jobs", async () => {
      await table().plant({ id: "dead", heartbeatAt: longAgo() });
      await table().plant({ id: "dead-too", heartbeatAt: longAgo() });
      await getSpecKitJob(P1, "dead");
      expect((await rowOf("dead-too")).status).toBe("running");
    });

    it("lists only live jobs of the project, oldest first", async () => {
      await table().plant({ id: "b", startedAt: new Date(realNow() - 1_000) });
      await table().plant({
        id: "a",
        startedAt: new Date(realNow() - 2_000),
        status: "cancelling",
      });
      await table().plant({ id: "dead", heartbeatAt: longAgo() });
      await table().plant({ id: "done", status: "succeeded", finishedAt: new Date() });
      await table().plant({ id: "other", projectId: P2, heartbeatAt: longAgo() });

      expect((await listActiveSpecKitJobs(P1)).map((j) => j.id)).toEqual(["a", "b"]);
      expect((await rowOf("dead")).status).toBe("failed");
      // The other project's dead job is not this list's to fail.
      expect((await rowOf("other")).status).toBe("running");
    });

    it("degrades unreadable stored JSON instead of throwing", async () => {
      const row = await table().plant({ id: "j", status: "failed", error: "{not json" });
      expect(toSpecKitJobDto(row).error?.code).toBe("INTERNAL_ERROR");
      const ok = await table().plant({ id: "k", status: "succeeded", result: "{not json" });
      expect(toSpecKitJobDto(ok).result).toBeNull();
    });
  });

  // A finished job keeps the last heartbeat it wrote. Minutes later that
  // heartbeat is "stale" — and the job must still be what it was.
  describe("a FINISHED job survives every stale check", () => {
    const RESULT = { message: "Generated plan.md (v2).", artifacts: ["plan.md"] };
    const ERROR = { status: 502, code: "SPEC_KIT_EMPTY_OUTPUT", message: "empty reply" };
    const plantFinished = async () => {
      const finishedAt = new Date(realNow() - SPEC_KIT_JOB_STALE_MS * 5);
      await table().plant({
        id: "ok",
        status: "succeeded",
        result: JSON.stringify(RESULT),
        finishedAt,
        heartbeatAt: longAgo(),
      });
      await table().plant({
        id: "bad",
        status: "failed",
        error: JSON.stringify(ERROR),
        finishedAt,
        heartbeatAt: longAgo(),
      });
      await table().plant({ id: "gone", status: "cancelled", finishedAt, heartbeatAt: longAgo() });
    };
    const expectUntouched = async () => {
      expect(await getSpecKitJob(P1, "ok")).toMatchObject({ status: "succeeded", result: RESULT });
      expect(await getSpecKitJob(P1, "bad")).toMatchObject({ status: "failed", error: ERROR });
      expect(await getSpecKitJob(P1, "gone")).toMatchObject({ status: "cancelled" });
      expect((await rowOf("ok")).result).toBe(JSON.stringify(RESULT));
    };

    it("when it is read", async () => {
      await plantFinished();
      await expectUntouched();
      expect(jobEvents.failed).not.toHaveBeenCalled();
    });

    it("when the sweeper runs", async () => {
      await plantFinished();
      expect(await failInterruptedSpecKitJobs()).toBe(0);
      await expectUntouched();
    });

    it("when the project's live jobs are listed", async () => {
      await plantFinished();
      expect(await listActiveSpecKitJobs(P1)).toEqual([]);
      await expectUntouched();
    });

    it("when it is cancelled again", async () => {
      await plantFinished();
      expect(await cancelSpecKitJob(P1, "ok", "u1")).toMatchObject({
        status: "succeeded",
        result: RESULT,
      });
      await expectUntouched();
      expect(auditSpy).not.toHaveBeenCalled();
    });
  });

  // The reviewer's probe P2. Staleness used to be `new Date()` on whichever
  // replica read the row, against a heartbeat stamped by the owner's clock.
  describe("staleness is judged on one clock — the database's", () => {
    const skew = (ms: number): void => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(realNow() + ms));
    };

    it.each([100_000, 3_600_000])(
      "a reader whose clock is %i ms AHEAD does not fail a live, heartbeating job",
      async (aheadMs) => {
        const reply = deferred();
        const started = await startSpecKitJob(base({ run: () => reply.promise }));
        const other = await startSpecKitJob(
          base({ run: () => reply.promise, featureSlug: "002-other" }),
        );

        // From here this process is the replica with the fast clock.
        skew(aheadMs);
        expect(await failInterruptedSpecKitJobs()).toBe(0);
        expect(await getSpecKitJob(P1, started.job.id)).toMatchObject({ status: "running" });
        expect((await listActiveSpecKitJobs(P1)).map((j) => j.id).sort()).toEqual(
          [started.job.id, other.job.id].sort(),
        );
        // A start that needs the key does not take it from a live holder either.
        await expect(startSpecKitJob(base())).rejects.toBeInstanceOf(SpecKitJobConflictError);
        expect(jobEvents.failed).not.toHaveBeenCalled();

        vi.useRealTimers();
        reply.resolve({ message: "ok" });
        expect((await started.done).status).toBe("succeeded");
        await other.done;
      },
    );

    it("an owner whose clock is far BEHIND does not have its heartbeats read as stale", async () => {
      skew(-3_600_000);
      const reply = deferred();
      const beat = vi.spyOn(store(), "beatJob");
      const started = await startSpecKitJob(base({ run: () => reply.promise, heartbeatMs: 5 }));
      await vi.waitFor(() => expect(beat.mock.results.length).toBeGreaterThanOrEqual(2), WAIT);
      await Promise.all(beat.mock.results.map((r) => r.value as Promise<unknown>));

      vi.useRealTimers();
      expect(await failInterruptedSpecKitJobs()).toBe(0);
      expect(await getSpecKitJob(P1, started.job.id)).toMatchObject({ status: "running" });
      reply.resolve({});
      await started.done;
    });

    it("an owner whose clock is far AHEAD does not keep a dead job alive", async () => {
      skew(3_600_000);
      const reply = deferred();
      const started = await startSpecKitJob(
        base({ run: () => reply.promise, heartbeatMs: 3_600_000 }),
      );
      vi.useRealTimers();
      // The owner dies: no more beats. The database's own clock moves on.
      const row = await rowOf(started.job.id);
      expect(Math.abs(realNow() - row.heartbeatAt.getTime())).toBeLessThan(60_000);
      await table().patch(started.job.id, {
        heartbeatAt: new Date(row.heartbeatAt.getTime() - SPEC_KIT_JOB_STALE_MS - 30_000),
      });
      expect(await failInterruptedSpecKitJobs()).toBe(1);
      reply.resolve({});
      await started.done;
    });
  });

  describe("restart recovery — the sweeper", () => {
    it("fails stale running jobs, cancels stale cancelling ones, and spares live ones", async () => {
      await table().plant({ id: "dead", heartbeatAt: longAgo(), activeKey: `${P1}:a` });
      await table().plant({
        id: "dead-cancelling",
        status: "cancelling",
        heartbeatAt: longAgo(),
        activeKey: `${P1}:b`,
      });
      await table().plant({ id: "alive", activeKey: `${P1}:c` });
      await table().plant({
        id: "dead-saving",
        status: "saving",
        heartbeatAt: longAgo(),
        activeKey: `${P1}:d`,
      });

      expect(await failInterruptedSpecKitJobs()).toBe(3);

      expect(await rowOf("dead")).toMatchObject({ status: "failed", activeKey: null });
      expect(await errorOf("dead")).toEqual(SPEC_KIT_JOB_INTERRUPTED_ERROR);
      expect(await rowOf("dead-saving")).toMatchObject({ status: "failed", activeKey: null });
      expect(await errorOf("dead-saving")).toEqual(SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR);
      expect(await rowOf("dead-cancelling")).toMatchObject({
        status: "cancelled",
        activeKey: null,
        error: null,
      });
      expect(await rowOf("alive")).toMatchObject({ status: "running", activeKey: `${P1}:c` });
      expect(jobEvents.failed).toHaveBeenCalledTimes(2);
      expect(jobEvents.completed).toHaveBeenCalledWith(
        "spec-kit",
        "dead-cancelling",
        P1,
        SPEC_KIT_JOB_CANCELLED_MESSAGE,
      );
      // A second pass finds nothing left to fail.
      expect(await failInterruptedSpecKitJobs()).toBe(0);
    });

    it("stops this process's own job when it is swept as stalled", async () => {
      const reply = deferred();
      const started = await startSpecKitJob(base({ run: () => reply.promise }));
      await table().patch(started.job.id, { heartbeatAt: longAgo() });

      expect(await failInterruptedSpecKitJobs()).toBe(1);
      const done = await started.done;
      expect(done).toMatchObject({ status: "failed", error: SPEC_KIT_JOB_INTERRUPTED_ERROR });
      reply.resolve({});
    });

    it("prunes jobs that finished more than the retention ago, and only those", async () => {
      const old = new Date(realNow() - SPEC_KIT_JOB_RETENTION_MS - 60_000);
      await table().plant({ id: "old", status: "succeeded", finishedAt: old });
      await table().plant({ id: "recent", status: "failed", finishedAt: new Date() });
      await table().plant({ id: "alive" });

      await failInterruptedSpecKitJobs();
      expect(await table().ids(PROJECTS)).toEqual(["alive", "recent"]);
    });

    it("sweeps at startup and then on its interval, until stopped", async () => {
      const sweep = vi.spyOn(store(), "failStaleJobs").mockResolvedValue([]);
      const prune = vi.spyOn(store(), "pruneFinishedJobs").mockResolvedValue(0);
      vi.useFakeTimers();
      const stop = startSpecKitJobSweeper(1_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sweep).toHaveBeenCalledTimes(3);
      expect(prune).toHaveBeenCalledWith(SPEC_KIT_JOB_RETENTION_MS);
      // Every job, by the one threshold.
      expect(sweep).toHaveBeenLastCalledWith({}, SPEC_KIT_JOB_STALE_MS, expect.anything());
      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sweep).toHaveBeenCalledTimes(3);
    });

    it("survives a sweep that throws", async () => {
      const sweep = vi.spyOn(store(), "failStaleJobs").mockRejectedValue(new Error("db down"));
      vi.useFakeTimers();
      const stop = startSpecKitJobSweeper(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweep).toHaveBeenCalledTimes(2);
      stop();
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
}
