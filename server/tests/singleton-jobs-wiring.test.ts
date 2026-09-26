/**
 * Issue #1303 — cluster-singleton job registration ratchet.
 *
 * `server/src/lib/workspaces/usage-rollup.ts` shipped in #763 exported, tested
 * and registered with NOTHING. It is the only writer of `workspace_usage_daily`,
 * and `lib/finops/forecast-service.ts:loadWorkspaceWindow` reads that table
 * behind the mounted `GET /api/workspaces/:workspaceId/finops` route. Because
 * `densifyWindow` fills a missing day with a zero-cost point, an empty table is
 * indistinguishable from a genuinely free month: every workspace-scope forecast
 * projected 0 cents and nothing anywhere errored.
 *
 * A unit test of `rollupWorkspaceUsage` cannot see that — being exercised by a
 * test was exactly the property the dead job already had (the same shape
 * `unmounted-middleware.test.ts` pins for middleware, #1083). So this test
 * asserts the REGISTRATION: the job is in the leader-only `SingletonJobs` set
 * alongside the forecaster that consumes its output, and losing leadership
 * stops it. Note it does NOT assert their relative order — both calls only arm
 * a `setInterval`, so array position has no runtime consequence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handleOf = (name: string) => ({ stop: vi.fn(), __name: name });

const mocks = vi.hoisted(() => ({
  startWorkspaceUsageRollup: vi.fn(),
  startForecastRecompute: vi.fn(),
  startSlaChecker: vi.fn(),
  startAlertEngine: vi.fn(),
  startChargebackScheduler: vi.fn(),
  startRevocationPruner: vi.fn(),
  reconcileStrandedGeneratedDocPublications: vi.fn(),
  bootLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Mod = Record<string, unknown>;
const partial = vi.hoisted(
  () => (key: string, fn: unknown) => async (importOriginal: () => Promise<Mod>) => ({
    ...(await importOriginal()),
    [key]: fn,
  }),
);

vi.mock(
  "../src/lib/workspaces/usage-rollup.js",
  partial("startWorkspaceUsageRollup", mocks.startWorkspaceUsageRollup),
);
vi.mock(
  "../src/lib/finops/forecast-service.js",
  partial("startForecastRecompute", mocks.startForecastRecompute),
);
vi.mock(
  "../src/lib/collaboration/sla-checker.js",
  partial("startSlaChecker", mocks.startSlaChecker),
);
vi.mock("../src/lib/finops/alert-engine.js", partial("startAlertEngine", mocks.startAlertEngine));
vi.mock(
  "../src/lib/finops/chargeback-scheduler.js",
  partial("startChargebackScheduler", mocks.startChargebackScheduler),
);
vi.mock(
  "../src/lib/auth/revocation-store.js",
  partial("startRevocationPruner", mocks.startRevocationPruner),
);

vi.mock(
  "../src/lib/docs-gen/generated-doc-publication-recovery.js",
  partial(
    "reconcileStrandedGeneratedDocPublications",
    mocks.reconcileStrandedGeneratedDocPublications,
  ),
);

// #201 — the bootstrap logger, so a test can read which failure was reported.
vi.mock("../src/lib/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/logger.js")>();
  return {
    ...original,
    createChildLogger: (module: string) =>
      module === "server-bootstrap" ? (mocks.bootLog as never) : original.createChildLogger(module),
  };
});

import { SingletonJobs } from "../src/server.js";

function fakeSchedulerBootstrap() {
  return {
    scheduler: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("SingletonJobs registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [name, fn] of Object.entries(mocks)) {
      if (typeof fn === "function") fn.mockReturnValue(handleOf(name));
    }
    mocks.reconcileStrandedGeneratedDocPublications.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts the workspace usage rollup on the leader", () => {
    const jobs = new SingletonJobs(fakeSchedulerBootstrap() as never);
    jobs.start();
    expect(mocks.startWorkspaceUsageRollup).toHaveBeenCalledTimes(1);
    jobs.stop();
  });

  it("registers the writer and its reader as one pair", () => {
    // Either half alone is the #1303 defect: the forecaster without the rollup
    // reads an all-zero window, and the rollup without the forecaster writes a
    // table nothing consumes.
    const jobs = new SingletonJobs(fakeSchedulerBootstrap() as never);
    jobs.start();
    expect(mocks.startWorkspaceUsageRollup).toHaveBeenCalledTimes(1);
    expect(mocks.startForecastRecompute).toHaveBeenCalledTimes(1);
    jobs.stop();
  });

  it("stops the rollup when leadership is lost", () => {
    const jobs = new SingletonJobs(fakeSchedulerBootstrap() as never);
    jobs.start();
    const handle = mocks.startWorkspaceUsageRollup.mock.results[0].value as {
      stop: ReturnType<typeof vi.fn>;
    };
    expect(handle.stop).not.toHaveBeenCalled();
    jobs.stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("#189 — settles stranded generated-doc publications once the scheduler has started", async () => {
    const sched = fakeSchedulerBootstrap();
    let finishStart!: () => void;
    sched.scheduler.start.mockReturnValue(
      new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
    );
    const jobs = new SingletonJobs(sched as never);
    jobs.start();
    await Promise.resolve();
    // Not before durable task recovery has re-queued the live tasks.
    expect(mocks.reconcileStrandedGeneratedDocPublications).not.toHaveBeenCalled();
    finishStart();
    await vi.waitFor(() =>
      expect(mocks.reconcileStrandedGeneratedDocPublications).toHaveBeenCalledTimes(1),
    );
    jobs.stop();
  });

  it("#189 — does not reconcile when the scheduler failed to start", async () => {
    const sched = fakeSchedulerBootstrap();
    sched.scheduler.start.mockRejectedValue(new Error("boom"));
    const jobs = new SingletonJobs(sched as never);
    jobs.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.reconcileStrandedGeneratedDocPublications).not.toHaveBeenCalled();
    jobs.stop();
  });

  it("#201 — reports a startup-repair failure as that, not as a scheduler start failure", async () => {
    mocks.reconcileStrandedGeneratedDocPublications.mockRejectedValue(new Error("db locked"));
    const jobs = new SingletonJobs(fakeSchedulerBootstrap() as never);
    jobs.start();
    await vi.waitFor(() =>
      expect(mocks.bootLog.warn).toHaveBeenCalledWith(
        "Generated-doc publication startup repair failed",
        { error: "db locked" },
      ),
    );
    expect(mocks.bootLog.warn).not.toHaveBeenCalledWith(
      "Scheduler start failed",
      expect.anything(),
    );
    jobs.stop();
  });

  it("#201 — still reports a scheduler that failed to start", async () => {
    const sched = fakeSchedulerBootstrap();
    sched.scheduler.start.mockRejectedValue(new Error("boom"));
    const jobs = new SingletonJobs(sched as never);
    jobs.start();
    await vi.waitFor(() =>
      expect(mocks.bootLog.warn).toHaveBeenCalledWith("Scheduler start failed", {
        error: "boom",
      }),
    );
    jobs.stop();
  });

  it("does not double-register the rollup when start() is called twice", () => {
    const jobs = new SingletonJobs(fakeSchedulerBootstrap() as never);
    jobs.start();
    jobs.start();
    expect(mocks.startWorkspaceUsageRollup).toHaveBeenCalledTimes(1);
    jobs.stop();
  });
});
