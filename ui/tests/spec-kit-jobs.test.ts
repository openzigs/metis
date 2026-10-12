/**
 * #1059 — running a Spec Kit command as a background job and watching it.
 * The API is scripted; nothing waits on a real interval (the sleep is injected,
 * or one millisecond), so no assertion depends on how fast the machine is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecKitJobDto } from "@metis/shared";

vi.mock("@/lib/spec-kit-api", () => ({
  specKitApi: {
    runCommand: vi.fn(),
    startCommandJob: vi.fn(),
    getJob: vi.fn(),
    listActiveJobs: vi.fn(),
    cancelJob: vi.fn(),
  },
}));

import { ApiError } from "@/lib/api-client";
import { specKitApi } from "@/lib/spec-kit-api";
import {
  SPEC_KIT_COMMAND_PENDING,
  SPEC_KIT_JOB_CANCELLED,
  SPEC_KIT_JOB_UNREACHABLE,
  SpecKitCommandPendingError,
  SpecKitJobAbandonedError,
  SpecKitJobCancelledError,
  SpecKitJobUnreachableError,
  findSpecKitJobToAttach,
  isFailedSend,
  isLostResponse,
  loadWatchedJob,
  runSpecKitCommand,
  saveWatchedJob,
  watchSpecKitJob,
} from "@/lib/spec-kit-jobs";

const api = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

const job = (over: Partial<SpecKitJobDto> = {}): SpecKitJobDto => ({
  id: "job-1",
  projectId: "p1",
  command: "speckit.plan",
  featureSlug: "001-mark-read",
  status: "running",
  phase: null,
  startedById: "me",
  startedAt: "2026-10-12T00:00:00.000Z",
  finishedAt: null,
  ...over,
});
const noWait = { sleep: async () => undefined };
const lost = (): ApiError => new ApiError(500, "Internal Server Error");
/** A clock on which every response comes back a minute after its request. */
const slowClock = (): (() => number) => {
  let t = 0;
  return () => (t += 60_000);
};

beforeEach(() => {
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listActiveJobs!.mockResolvedValue({ jobs: [] });
});

describe("runSpecKitCommand — a model-backed command is a job", () => {
  it("starts the job once, watches it, and resolves with the command's result", async () => {
    const running = job();
    api.startCommandJob!.mockResolvedValue({ jobId: "job-1", job: running });
    api
      .getJob!.mockResolvedValueOnce({ job: job({ phase: "Generating plan.md (1 of 5)" }) })
      .mockResolvedValueOnce({ job: job({ phase: "Generating research.md (2 of 5)" }) })
      .mockResolvedValueOnce({
        job: job({
          status: "succeeded",
          phase: "Saving the plan artifacts",
          result: { message: "Generated 5 plan artifacts", artifacts: [{ key: "plan.md" }] },
        }),
      });
    const seen: Array<[string, string | null]> = [];
    let storedWhileRunning: unknown;

    const result = await runSpecKitCommand(
      "p1",
      "speckit.plan",
      { featureSlug: "001-mark-read" },
      {
        ...noWait,
        onUpdate: (j) => {
          seen.push([j.status, j.phase]);
          if (j.status === "running") storedWhileRunning = loadWatchedJob("p1");
        },
      },
    );

    expect(result).toEqual({
      message: "Generated 5 plan artifacts",
      artifacts: [{ key: "plan.md" }],
    });
    expect(api.startCommandJob).toHaveBeenCalledTimes(1);
    expect(api.startCommandJob).toHaveBeenCalledWith("p1", "speckit.plan", {
      featureSlug: "001-mark-read",
    });
    expect(api.runCommand).not.toHaveBeenCalled();
    expect(seen).toEqual([
      ["running", null],
      ["running", "Generating plan.md (1 of 5)"],
      ["running", "Generating research.md (2 of 5)"],
      ["succeeded", "Saving the plan artifacts"],
    ]);
    // Kept while it runs, so a reload can re-attach; forgotten once it is over.
    expect(storedWhileRunning).toEqual({
      jobId: "job-1",
      command: "speckit.plan",
      featureSlug: "001-mark-read",
    });
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it("rejects with the server's status, code, message and details when the job failed", async () => {
    api.startCommandJob!.mockResolvedValue({ jobId: "job-1", job: job() });
    api.getJob!.mockResolvedValue({
      job: job({
        status: "failed",
        error: {
          status: 412,
          code: "SPECKIT_GATE_UNMET",
          message: "spec.md is required",
          details: { required: "specGate" },
        },
      }),
    });

    const err = await runSpecKitCommand("p1", "speckit.plan", {}, noWait).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 412,
      code: "SPECKIT_GATE_UNMET",
      message: "spec.md is required",
      details: { required: "specGate" },
    });
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it("does not look for a job when the start is refused with a code", async () => {
    const refused = new ApiError(409, "/speckit.plan is already running", "SPEC_KIT_JOB_RUNNING");
    api.startCommandJob!.mockRejectedValue(refused);
    await expect(runSpecKitCommand("p1", "speckit.plan", {}, noWait)).rejects.toBe(refused);
    expect(api.listActiveJobs).not.toHaveBeenCalled();
    expect(loadWatchedJob("p1")).toBeNull();
  });

  describe("when the response to the START is lost", () => {
    it("watches the job it finds running for this command, feature and viewer — never starts a second", async () => {
      api.startCommandJob!.mockRejectedValue(lost());
      api.listActiveJobs!.mockResolvedValue({
        jobs: [
          job({ id: "theirs", startedById: "someone-else" }),
          job({ id: "other-feature", featureSlug: "002-x" }),
          job({ id: "other-command", command: "speckit.tasks" }),
          job({ id: "mine" }),
        ],
      });
      api.getJob!.mockResolvedValue({
        job: job({ id: "mine", status: "succeeded", result: { message: "done" } }),
      });

      const result = await runSpecKitCommand(
        "p1",
        "speckit.plan",
        { featureSlug: "001-mark-read" },
        { ...noWait, userId: "me" },
      );

      expect(result.message).toBe("done");
      expect(api.getJob).toHaveBeenCalledWith("p1", "mine");
      expect(api.startCommandJob).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["no job is running", { jobs: [] }],
      ["only someone else's is", { jobs: [job({ startedById: "someone-else" })] }],
    ])("shows the start's own error when %s", async (_name, active) => {
      const failure = new TypeError("Failed to fetch");
      api.startCommandJob!.mockRejectedValue(failure);
      api.listActiveJobs!.mockResolvedValue(active);
      await expect(
        runSpecKitCommand(
          "p1",
          "speckit.plan",
          { featureSlug: "001-mark-read" },
          {
            ...noWait,
            userId: "me",
          },
        ),
      ).rejects.toBe(failure);
      expect(api.startCommandJob).toHaveBeenCalledTimes(1);
    });

    it("shows the start's own error when the running jobs cannot be listed either", async () => {
      const failure = lost();
      api.startCommandJob!.mockRejectedValue(failure);
      api.listActiveJobs!.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(runSpecKitCommand("p1", "speckit.plan", {}, noWait)).rejects.toBe(failure);
    });
  });
});

describe("runSpecKitCommand — a command that is not a job is one request", () => {
  it.each(["speckit.constitution", "speckit.implement", "speckit.taskstoissues"] as const)(
    "%s",
    async (command) => {
      api.runCommand!.mockResolvedValue({ message: "ok" });
      await expect(runSpecKitCommand("p1", command, { input: "x" })).resolves.toEqual({
        message: "ok",
      });
      expect(api.runCommand).toHaveBeenCalledWith("p1", command, { input: "x" });
      expect(api.startCommandJob).not.toHaveBeenCalled();
      expect(loadWatchedJob("p1")).toBeNull();
    },
  );

  it.each([
    ["a bare 5xx", lost()],
    ["a failed fetch", new TypeError("Failed to fetch")],
  ])("reports %s as an unknown outcome, never resending", async (_name, failure) => {
    api.runCommand!.mockRejectedValue(failure);
    const err = await runSpecKitCommand(
      "p1",
      "speckit.taskstoissues",
      {},
      { now: slowClock() },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecKitCommandPendingError);
    expect((err as Error).message).toBe(SPEC_KIT_COMMAND_PENDING);
    expect(api.runCommand).toHaveBeenCalledTimes(1);
  });

  it("shows a failure the server reported, and a send that failed at once, as they are", async () => {
    const coded = new ApiError(502, "GitHub refused the token", "SPECKIT_EXPORT_FAILED");
    api.runCommand!.mockRejectedValue(coded);
    await expect(
      runSpecKitCommand("p1", "speckit.taskstoissues", {}, { now: slowClock() }),
    ).rejects.toBe(coded);

    const refused = new TypeError("Failed to fetch");
    api.runCommand!.mockRejectedValue(refused);
    // The same instant on the clock: the request never left.
    await expect(
      runSpecKitCommand("p1", "speckit.implement", {}, { now: () => 1_000 }),
    ).rejects.toBe(refused);
  });
});

describe("watchSpecKitJob", () => {
  it("reads at once when the job's state is not known yet", async () => {
    api.getJob!.mockResolvedValue({ job: job({ status: "succeeded", result: null }) });
    const sleep = vi.fn(async () => undefined);
    // A result with no message still renders: the page reads `message`.
    await expect(watchSpecKitJob("p1", "job-1", { sleep })).resolves.toEqual({ message: "" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects with a cancellation, not an error envelope, for a cancelled job", async () => {
    api.getJob!.mockResolvedValue({ job: job({ status: "cancelled" }) });
    const err = await watchSpecKitJob("p1", "job-1", noWait).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecKitJobCancelledError);
    expect((err as Error).message).toBe(SPEC_KIT_JOB_CANCELLED);
  });

  it("keeps watching through `cancelling`", async () => {
    api
      .getJob!.mockResolvedValueOnce({ job: job({ status: "cancelling" }) })
      .mockResolvedValueOnce({ job: job({ status: "cancelled" }) });
    await expect(watchSpecKitJob("p1", "job-1", noWait)).rejects.toBeInstanceOf(
      SpecKitJobCancelledError,
    );
    expect(api.getJob).toHaveBeenCalledTimes(2);
  });

  it("falls back to a generic failure when a failed job carries no error", async () => {
    api.getJob!.mockResolvedValue({ job: job({ status: "failed" }) });
    await expect(watchSpecKitJob("p1", "job-1", noWait)).rejects.toMatchObject({
      status: 500,
      message: "The Spec Kit command failed.",
    });
  });

  it("rides out reads that fail and counts only CONSECUTIVE failures", async () => {
    const down = (): Promise<never> => Promise.reject(new TypeError("Failed to fetch"));
    api
      .getJob!.mockImplementationOnce(down)
      .mockImplementationOnce(() => Promise.reject(new ApiError(502, "Bad Gateway")))
      .mockImplementationOnce(() => Promise.reject(new ApiError(429, "slow down", "RATE")))
      .mockResolvedValueOnce({ job: job() }) // back: the count starts over
      .mockImplementationOnce(down)
      .mockImplementationOnce(down)
      .mockImplementationOnce(down)
      .mockResolvedValueOnce({ job: job({ status: "succeeded", result: { message: "done" } }) });

    await expect(
      watchSpecKitJob("p1", "job-1", { ...noWait, maxReadFailures: 4 }),
    ).resolves.toEqual({ message: "done" });
    expect(api.getJob).toHaveBeenCalledTimes(8);
  });

  it("stops after too many failed reads in a row, saying the job carries on — and stays re-attachable", async () => {
    saveWatchedJob("p1", { jobId: "job-1", command: "speckit.plan", featureSlug: null });
    api.getJob!.mockRejectedValue(new TypeError("Failed to fetch"));

    const err = await watchSpecKitJob("p1", "job-1", { ...noWait, maxReadFailures: 3 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SpecKitJobUnreachableError);
    expect((err as Error).message).toBe(SPEC_KIT_JOB_UNREACHABLE);
    expect(api.getJob).toHaveBeenCalledTimes(3);
    expect(loadWatchedJob("p1")?.jobId).toBe("job-1");
  });

  it.each([404, 403, 401])("gives up at once on a %i and forgets the job", async (status) => {
    saveWatchedJob("p1", { jobId: "job-1", command: "speckit.plan", featureSlug: null });
    const gone = new ApiError(status, "No such Spec Kit job", "SPEC_KIT_JOB_NOT_FOUND");
    api.getJob!.mockRejectedValue(gone);
    await expect(watchSpecKitJob("p1", "job-1", noWait)).rejects.toBe(gone);
    expect(api.getJob).toHaveBeenCalledTimes(1);
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it("stops reading the moment the page is left, and leaves the job re-attachable", async () => {
    saveWatchedJob("p1", { jobId: "job-1", command: "speckit.plan", featureSlug: null });
    const left = new AbortController();
    api.getJob!.mockImplementation(async () => {
      left.abort(); // the page is left while this read is in flight
      return { job: job({ status: "succeeded", result: { message: "done" } }) };
    });
    const onUpdate = vi.fn();

    await expect(
      watchSpecKitJob("p1", "job-1", { ...noWait, signal: left.signal, onUpdate }),
    ).rejects.toBeInstanceOf(SpecKitJobAbandonedError);

    expect(onUpdate).not.toHaveBeenCalled();
    expect(api.getJob).toHaveBeenCalledTimes(1);
    expect(loadWatchedJob("p1")?.jobId).toBe("job-1");
  });

  it("makes no read at all for a page already left", async () => {
    const left = new AbortController();
    left.abort();
    await expect(
      watchSpecKitJob("p1", "job-1", { signal: left.signal }, job()),
    ).rejects.toBeInstanceOf(SpecKitJobAbandonedError);
    expect(api.getJob).not.toHaveBeenCalled();
  });

  it("treats a read that fails after the page was left as leaving, not as a failure", async () => {
    const left = new AbortController();
    api.getJob!.mockImplementation(async () => {
      left.abort();
      throw new ApiError(404, "gone", "SPEC_KIT_JOB_NOT_FOUND");
    });
    await expect(
      watchSpecKitJob("p1", "job-1", { ...noWait, signal: left.signal }),
    ).rejects.toBeInstanceOf(SpecKitJobAbandonedError);
  });

  it("waits between reads on a real timer, and wakes at once when the page is left", async () => {
    const left = new AbortController();
    api.getJob!.mockResolvedValue({ job: job() });
    // An interval far longer than the test: only the abort can end the wait.
    const watching = watchSpecKitJob("p1", "job-1", {
      signal: left.signal,
      intervalMs: 3_600_000,
    });
    await vi.waitFor(() => expect(api.getJob).toHaveBeenCalledTimes(1));
    left.abort();
    await expect(watching).rejects.toBeInstanceOf(SpecKitJobAbandonedError);

    // And without an abort, a short real interval does elapse.
    api.getJob!.mockReset();
    api
      .getJob!.mockResolvedValueOnce({ job: job() })
      .mockResolvedValueOnce({ job: job({ status: "succeeded", result: { message: "ok" } }) });
    await expect(watchSpecKitJob("p1", "job-1", { intervalMs: 1 })).resolves.toEqual({
      message: "ok",
    });
  });
});

describe("findSpecKitJobToAttach — what a freshly opened page picks up", () => {
  it("returns nothing when the viewer has no job", async () => {
    api.listActiveJobs!.mockResolvedValue({ jobs: [job({ startedById: "someone-else" })] });
    expect(await findSpecKitJobToAttach("p1", "me")).toBeNull();
    expect(api.getJob).not.toHaveBeenCalled();
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it("returns the viewer's running job, preferring the one this tab was watching", async () => {
    saveWatchedJob("p1", { jobId: "b", command: "speckit.plan", featureSlug: null });
    api.listActiveJobs!.mockResolvedValue({
      jobs: [job({ id: "a" }), job({ id: "b", featureSlug: "002-b" }), job({ id: "c" })],
    });
    expect((await findSpecKitJobToAttach("p1", "me"))?.id).toBe("b");
    expect(loadWatchedJob("p1")).toEqual({
      jobId: "b",
      command: "speckit.plan",
      featureSlug: "002-b",
    });
  });

  it("returns a running job started from another tab, and remembers it", async () => {
    api.listActiveJobs!.mockResolvedValue({ jobs: [job({ id: "elsewhere" })] });
    expect((await findSpecKitJobToAttach("p1", "me"))?.id).toBe("elsewhere");
    expect(loadWatchedJob("p1")?.jobId).toBe("elsewhere");
  });

  it("returns the watched job that finished while the page was away", async () => {
    saveWatchedJob("p1", { jobId: "job-1", command: "speckit.plan", featureSlug: null });
    const finished = job({ status: "failed", error: { status: 502, code: "X", message: "m" } });
    api.getJob!.mockResolvedValue({ job: finished });
    expect(await findSpecKitJobToAttach("p1", "me")).toEqual(finished);
    expect(api.getJob).toHaveBeenCalledWith("p1", "job-1");
  });

  it("still reads the watched job when the list cannot be read", async () => {
    saveWatchedJob("p1", { jobId: "job-1", command: "speckit.plan", featureSlug: null });
    api.listActiveJobs!.mockRejectedValue(new TypeError("Failed to fetch"));
    api.getJob!.mockResolvedValue({ job: job() });
    expect((await findSpecKitJobToAttach("p1", "me"))?.id).toBe("job-1");
  });

  it("forgets a watched job that is gone, and keeps one that merely could not be read", async () => {
    saveWatchedJob("p1", { jobId: "job-1", command: "speckit.plan", featureSlug: null });
    api.getJob!.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await findSpecKitJobToAttach("p1", "me")).toBeNull();
    expect(loadWatchedJob("p1")?.jobId).toBe("job-1");

    api.getJob!.mockRejectedValue(new ApiError(404, "gone", "SPEC_KIT_JOB_NOT_FOUND"));
    expect(await findSpecKitJobToAttach("p1", "me")).toBeNull();
    expect(loadWatchedJob("p1")).toBeNull();
  });
});

describe("the watched job in session storage", () => {
  it("round-trips per project", () => {
    saveWatchedJob("p1", { jobId: "j", command: "speckit.tasks", featureSlug: "001-a" });
    expect(loadWatchedJob("p1")).toEqual({
      jobId: "j",
      command: "speckit.tasks",
      featureSlug: "001-a",
    });
    expect(loadWatchedJob("p2")).toBeNull();
    saveWatchedJob("p1", null);
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it.each([
    ["not JSON", "{nope"],
    ["no job id", JSON.stringify({ command: "speckit.plan" })],
    ["a command that is not one", JSON.stringify({ jobId: "j", command: "rm -rf" })],
    ["a non-string command", JSON.stringify({ jobId: "j", command: 7 })],
  ])("ignores a stored value that is %s", (_name, raw) => {
    window.sessionStorage.setItem("metis:spec-kit-job:p1", raw);
    expect(loadWatchedJob("p1")).toBeNull();
  });

  it("reads a missing feature as the project-level set", () => {
    window.sessionStorage.setItem(
      "metis:spec-kit-job:p1",
      JSON.stringify({ jobId: "j", command: "speckit.specify" }),
    );
    expect(loadWatchedJob("p1")?.featureSlug).toBeNull();
  });

  it("survives storage that refuses to write", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      saveWatchedJob("p1", { jobId: "j", command: "speckit.plan", featureSlug: null }),
    ).not.toThrow();
    setItem.mockRestore();
  });
});

describe("isLostResponse / isFailedSend", () => {
  it("a lost response is a failed fetch or a 5xx with no error code", () => {
    expect(isLostResponse(new TypeError("Failed to fetch"))).toBe(true);
    expect(isLostResponse(new ApiError(500, "Internal Server Error"))).toBe(true);
    expect(isLostResponse(new ApiError(502, "x", "SPEC_KIT_EMPTY_OUTPUT"))).toBe(false);
    expect(isLostResponse(new ApiError(409, "x"))).toBe(false);
    expect(isLostResponse(new Error("other"))).toBe(false);
  });

  it("a failed send is one that came back at once, or while offline", () => {
    expect(isFailedSend(2_999)).toBe(true);
    expect(isFailedSend(3_000)).toBe(false);
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    expect(isFailedSend(60_000)).toBe(true);
    onLine.mockRestore();
  });
});
