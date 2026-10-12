/**
 * #1069 — a Spec Kit command whose response was lost is recovered by polling
 * the artifact it was writing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/spec-kit-api", () => ({
  specKitApi: {
    runCommand: vi.fn(),
    listFiles: vi.fn(),
    listFeatures: vi.fn(),
    listFeatureArtifacts: vi.fn(),
  },
}));

import { ApiError } from "@/lib/api-client";
import { specKitApi } from "@/lib/spec-kit-api";
import { describeSpecKitError, specKitErrorCode } from "@/lib/spec-kit-display";
import {
  SPEC_KIT_COMMAND_PENDING,
  SPEC_KIT_FAILED_SEND_MS,
  SPEC_KIT_RECOVERY_ATTEMPTS,
  SPEC_KIT_RECOVERY_INTERVAL_MS,
  SpecKitCommandCancelledError,
  SpecKitCommandPendingError,
  commandWrites,
  isFailedSend,
  isLostResponse,
  newerArtifacts,
  runSpecKitCommandWithRecovery,
} from "@/lib/spec-kit-recovery";

const m = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** What `apiFetch` throws for the proxy's own 500: status text, no envelope. */
const proxy500 = (): ApiError => new ApiError(500, "Internal Server Error");
const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
/** A clock on which the response is lost `elapsedMs` after the command was sent. */
const lostAfter = (elapsedMs: number): (() => number) => {
  let calls = 0;
  return () => (calls++ === 0 ? 1_000 : 1_000 + elapsedMs);
};
/** Lost a minute in: a command that ran, not a send that failed. */
const timing = { intervalMs: 7, attempts: 3, sleep, now: lostAfter(60_000) };

const artifacts = (versions: Record<string, number>) => ({
  feature: { slug: "f1" },
  artifacts: Object.entries(versions).map(([key, version]) => ({ key, version })),
});
const files = (versions: Record<string, number>) => ({
  enabled: true,
  artifacts: Object.entries(versions).map(([name, version]) => ({ name, version })),
});
const feature = (slug: string, updatedAt: string) => ({
  id: `id_${slug}`,
  slug,
  title: `Title of ${slug}`,
  status: "draft",
  branchName: null,
  updatedAt,
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  sleep.mockReset().mockImplementation(async () => {});
  timing.now = lostAfter(60_000);
  m.listFiles!.mockResolvedValue(files({}));
  m.listFeatures!.mockResolvedValue({ features: [] });
  m.listFeatureArtifacts!.mockResolvedValue(artifacts({}));
});

describe("isLostResponse", () => {
  it("is true for a 5xx with no error envelope and for a failed fetch", () => {
    expect(isLostResponse(proxy500())).toBe(true);
    expect(isLostResponse(new ApiError(504, "Gateway Timeout"))).toBe(true);
    expect(isLostResponse(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("is false when the server reported the failure itself, and for a 4xx", () => {
    expect(isLostResponse(new ApiError(502, "no key", "AI_PROVIDER_KEY_UNAVAILABLE"))).toBe(false);
    expect(isLostResponse(new ApiError(500, "boom", "INTERNAL_ERROR"))).toBe(false);
    expect(isLostResponse(new ApiError(409, "Conflict"))).toBe(false);
    expect(isLostResponse(new Error("a bug, not the network"))).toBe(false);
    expect(isLostResponse("nope")).toBe(false);
  });
});

describe("newerArtifacts", () => {
  it("names new keys and greater versions only", () => {
    expect(
      newerArtifacts({ "spec.md": 2, "plan.md": 1 }, { "spec.md": 2, "plan.md": 2, "x.md": 1 }),
    ).toEqual(["plan.md", "x.md"]);
    expect(newerArtifacts({ "spec.md": 2 }, { "spec.md": 1 })).toEqual([]);
    expect(newerArtifacts({ "spec.md": 2 }, {})).toEqual([]);
  });
});

describe("runSpecKitCommandWithRecovery", () => {
  it("returns the command's own result without polling", async () => {
    m.runCommand!.mockResolvedValue({ message: "planned" });
    const result = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.plan",
      { featureSlug: "f1" },
      timing,
    );
    expect(result).toEqual({ message: "planned" });
    expect(m.runCommand).toHaveBeenCalledWith("p1", "speckit.plan", { featureSlug: "f1" });
    // One read for the baseline, none after.
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("after a bare 5xx, polls the feature's artifacts and returns the newer ones", async () => {
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "spec.md": 3, "plan.md": 1 }))
      .mockResolvedValueOnce(artifacts({ "spec.md": 3, "plan.md": 1 }))
      .mockResolvedValueOnce(artifacts({ "spec.md": 3, "plan.md": 2, "research.md": 1 }));
    m.runCommand!.mockRejectedValue(proxy500());

    const result = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.plan",
      { featureSlug: "f1" },
      timing,
    );

    expect(result).toEqual({
      message:
        "The command's response was lost, but a newer plan.md, research.md was saved. Showing it.",
      artifacts: [{ key: "plan.md" }, { key: "research.md" }],
    });
    expect(m.listFeatureArtifacts).toHaveBeenCalledWith("p1", "f1");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7, undefined);
    // The command is a write: it is never resent.
    expect(m.runCommand).toHaveBeenCalledTimes(1);
  });

  it("after a network error at project level, returns the newer project file", async () => {
    m.listFiles!.mockResolvedValueOnce(files({ "constitution.md": 1 })).mockResolvedValueOnce(
      files({ "constitution.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await runSpecKitCommandWithRecovery("p1", "speckit.constitution", {}, timing);

    expect(result).toEqual({
      message:
        "The command's response was lost, but a newer constitution.md was saved. Showing it.",
      artifactName: "constitution.md",
    });
    expect(m.listFeatures).toHaveBeenCalledWith("p1", false);
    expect(m.listFeatureArtifacts).not.toHaveBeenCalled();
  });

  it("returns the feature a lost /speckit.specify created or updated", async () => {
    const old = feature("old", "2026-10-01T00:00:00.000Z");
    const created = feature("new", "2026-10-11T00:00:00.000Z");
    m.listFeatures!.mockResolvedValueOnce({ features: [old] }).mockResolvedValueOnce({
      features: [old, created],
    });
    m.runCommand!.mockRejectedValue(proxy500());
    expect(await runSpecKitCommandWithRecovery("p1", "speckit.specify", {}, timing)).toEqual({
      message:
        'The command\'s response was lost, but a newer feature "Title of new" was saved. Showing it.',
      feature: created,
    });

    const touched = feature("old", "2026-10-11T00:00:00.000Z");
    timing.now = lostAfter(60_000);
    m.listFeatures!.mockReset();
    m.listFeatures!.mockResolvedValueOnce({ features: [old] }).mockResolvedValueOnce({
      features: [touched],
    });
    const result = await runSpecKitCommandWithRecovery("p1", "speckit.specify", {}, timing);
    expect(result.feature).toEqual(touched);
  });

  it("gives up with the plain message after the bounded number of reads", async () => {
    m.listFeatureArtifacts!.mockResolvedValue(artifacts({ "plan.md": 1 }));
    m.runCommand!.mockRejectedValue(proxy500());

    const run = runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" }, timing);
    await expect(run).rejects.toBeInstanceOf(SpecKitCommandPendingError);
    await expect(run).rejects.toThrow(SPEC_KIT_COMMAND_PENDING);
    expect(sleep).toHaveBeenCalledTimes(3);
    // Baseline + one read per attempt.
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(4);
  });

  it("keeps polling through a failed read", async () => {
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "plan.md": 1 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(artifacts({ "plan.md": 2 }));
    m.runCommand!.mockRejectedValue(proxy500());
    const result = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.plan",
      { featureSlug: "f1" },
      timing,
    );
    expect(result.artifacts).toEqual([{ key: "plan.md" }]);
  });

  it("shows the plain message without polling when there was no baseline to compare with", async () => {
    m.listFeatureArtifacts!.mockRejectedValue(new ApiError(503, "Service Unavailable"));
    m.runCommand!.mockRejectedValue(proxy500());
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" }, timing),
    ).rejects.toBeInstanceOf(SpecKitCommandPendingError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["speckit.taskstoissues", { featureSlug: "f1" }],
    ["speckit.implement", { featureSlug: "f1" }],
    ["speckit.implement", {}],
  ] as const)("does not poll for %s %j, which saves no artifact", async (command, options) => {
    // An artifact does move meanwhile: it is still not this command's result.
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "tasks.md": 1 })).mockResolvedValue(
      artifacts({ "tasks.md": 2 }),
    );
    m.listFiles!.mockResolvedValueOnce(files({ "tasks.md": 1 })).mockResolvedValue(
      files({ "tasks.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(proxy500());
    await expect(
      runSpecKitCommandWithRecovery("p1", command, options, timing),
    ).rejects.toBeInstanceOf(SpecKitCommandPendingError);
    expect(m.listFeatureArtifacts).not.toHaveBeenCalled();
    expect(m.listFiles).not.toHaveBeenCalled();
    expect(m.listFeatures).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows an error the server reported, without polling", async () => {
    const reported = new ApiError(502, "/plan: nothing was saved.", "SPEC_KIT_EMPTY_OUTPUT");
    m.runCommand!.mockRejectedValue(reported);
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" }, timing),
    ).rejects.toBe(reported);
    expect(sleep).not.toHaveBeenCalled();
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
  });

  it("polls for a bounded period by default", () => {
    expect(SPEC_KIT_RECOVERY_INTERVAL_MS * SPEC_KIT_RECOVERY_ATTEMPTS).toBe(180_000);
  });

  it("waits on a real timer when no sleep is injected", async () => {
    vi.useFakeTimers();
    try {
      m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "plan.md": 1 })).mockResolvedValue(
        artifacts({ "plan.md": 2 }),
      );
      // Lost a minute after it was sent, on the real (faked) clock.
      m.runCommand!.mockImplementation(
        () => new Promise((_resolve, reject) => setTimeout(() => reject(proxy500()), 60_000)),
      );
      const run = runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(SPEC_KIT_RECOVERY_INTERVAL_MS - 1);
      expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await run).artifacts).toEqual([{ key: "plan.md" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a send that failed is not a lost response", () => {
  it("isFailedSend is true below the threshold and when the browser is offline", () => {
    expect(SPEC_KIT_FAILED_SEND_MS).toBe(3_000);
    expect(isFailedSend(0)).toBe(true);
    expect(isFailedSend(2_999)).toBe(true);
    expect(isFailedSend(3_000)).toBe(false);
    expect(isFailedSend(600_000)).toBe(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isFailedSend(600_000)).toBe(true);
  });

  it.each([
    ["a bare 500 from the proxy (the API server is down)", proxy500()],
    ["a fetch that never left", new TypeError("Failed to fetch")],
  ])("fails at once, without polling, on %s", async (_name, err) => {
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "plan.md": 1 })).mockResolvedValue(
      artifacts({ "plan.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(err);
    await expect(
      runSpecKitCommandWithRecovery(
        "p1",
        "speckit.plan",
        { featureSlug: "f1" },
        { ...timing, now: lostAfter(SPEC_KIT_FAILED_SEND_MS - 1) },
      ),
    ).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
    // The baseline only: nothing is read after the failure.
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
  });

  it("polls once the threshold has passed", async () => {
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "plan.md": 1 })).mockResolvedValue(
      artifacts({ "plan.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(proxy500());
    const result = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.plan",
      { featureSlug: "f1" },
      { ...timing, now: lostAfter(SPEC_KIT_FAILED_SEND_MS) },
    );
    expect(result.artifacts).toEqual([{ key: "plan.md" }]);
  });

  it("fails at once when the browser is offline, however long the command ran", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const err = new TypeError("Failed to fetch");
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "plan.md": 1 })).mockResolvedValue(
      artifacts({ "plan.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(err);
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" }, timing),
    ).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
  });

  it("measures on the real clock when none is injected", async () => {
    // Rejected in the same tick it was sent: 0 ms on Date.now.
    m.runCommand!.mockRejectedValue(proxy500());
    const { now: _now, ...realClock } = timing;
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" }, realClock),
    ).rejects.toBeInstanceOf(ApiError);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("speckit.plan and its plan-context.md record (#1060)", () => {
  it("recognises a finished plan before the record is written, and never shows the record as the result", async () => {
    // The server writes plan-context.md after plan.md. A poll that lands between
    // the two sees the generated artifacts and no record: the plan is found.
    m.listFeatureArtifacts!.mockResolvedValueOnce(
      artifacts({ "spec.md": 1, "plan.md": 1 }),
    ).mockResolvedValueOnce(
      artifacts({ "spec.md": 1, "research.md": 1, "data-model.md": 1, "plan.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(proxy500());
    const early = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.plan",
      { featureSlug: "f1" },
      timing,
    );
    expect(early.artifacts).toEqual([
      { key: "research.md" },
      { key: "data-model.md" },
      { key: "plan.md" },
    ]);

    // A poll that lands after it: the record changed too, and is not listed.
    timing.now = lostAfter(60_000);
    m.listFeatureArtifacts!.mockReset();
    m.listFeatureArtifacts!.mockResolvedValueOnce(
      artifacts({ "spec.md": 1, "plan.md": 1, "plan-context.md": 1 }),
    ).mockResolvedValueOnce(artifacts({ "spec.md": 1, "plan.md": 2, "plan-context.md": 2 }));
    const late = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.plan",
      { featureSlug: "f1" },
      timing,
    );
    expect(late.artifacts).toEqual([{ key: "plan.md" }]);
    expect(late.message).not.toContain("plan-context.md");
  });

  it("does not take a new record alone for a finished plan", async () => {
    // The record without a newer plan.md is not this command's result.
    m.listFeatureArtifacts!.mockResolvedValueOnce(
      artifacts({ "spec.md": 1, "plan.md": 1 }),
    ).mockResolvedValue(artifacts({ "spec.md": 1, "plan.md": 1, "plan-context.md": 1 }));
    m.runCommand!.mockRejectedValue(proxy500());
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" }, timing),
    ).rejects.toBeInstanceOf(SpecKitCommandPendingError);
  });
});

describe("only this command's own artifacts count as its result", () => {
  it("commandWrites names what each command writes, per scope", () => {
    const writes = (
      command: Parameters<typeof commandWrites>[0],
      featureSlug: string | undefined,
      keys: string[],
    ): string[] => keys.filter(commandWrites(command, featureSlug) ?? (() => false));
    const featureKeys = [
      "spec.md",
      "clarify.md",
      "plan.md",
      "research.md",
      "data-model.md",
      "quickstart.md",
      "contracts/api.openapi.yaml",
      "checklist-security.md",
      "tasks.md",
      "analysis.md",
      // #1060 — METIS's record of what the planner was given. `speckit.plan`
      // writes it, last, and it is no command's RESULT: none of the lists below has it.
      "plan-context.md",
    ];
    expect(writes("speckit.specify", "f1", featureKeys)).toEqual(["spec.md"]);
    expect(writes("speckit.clarify", "f1", featureKeys)).toEqual(["clarify.md"]);
    expect(writes("speckit.plan", "f1", featureKeys)).toEqual([
      "plan.md",
      "research.md",
      "data-model.md",
      "quickstart.md",
      "contracts/api.openapi.yaml",
    ]);
    expect(writes("speckit.checklist", "f1", featureKeys)).toEqual(["checklist-security.md"]);
    expect(writes("speckit.tasks", "f1", featureKeys)).toEqual(["tasks.md"]);
    expect(writes("speckit.analyze", "f1", featureKeys)).toEqual(["analysis.md"]);

    const projectKeys = [
      "spec.md",
      "plan.md",
      "tasks.md",
      "constitution.md",
      "clarify.md",
      "analysis.md",
      "feature:f1",
    ];
    expect(writes("speckit.constitution", undefined, projectKeys)).toEqual(["constitution.md"]);
    expect(writes("speckit.specify", undefined, projectKeys)).toEqual(["feature:f1"]);
    expect(writes("speckit.clarify", undefined, projectKeys)).toEqual(["clarify.md"]);
    expect(writes("speckit.tasks", undefined, projectKeys)).toEqual(["tasks.md"]);
    expect(writes("speckit.analyze", undefined, projectKeys)).toEqual(["analysis.md"]);

    for (const [command, slug] of [
      ["speckit.implement", "f1"],
      ["speckit.implement", undefined],
      ["speckit.taskstoissues", "f1"],
      ["speckit.constitution", "f1"],
      ["speckit.plan", undefined],
      ["speckit.checklist", undefined],
    ] as const) {
      expect(commandWrites(command, slug)).toBeNull();
    }
  });

  it("at project level, ignores a feature someone else touched", async () => {
    // A collaborator re-specifies feature f2 while /speckit.constitution runs.
    m.listFiles!.mockResolvedValue(files({ "constitution.md": 1 }));
    m.listFeatures!.mockResolvedValueOnce({
      features: [feature("f2", "2026-10-01T00:00:00.000Z")],
    }).mockResolvedValue({ features: [feature("f2", "2026-10-11T00:00:00.000Z")] });
    m.runCommand!.mockRejectedValue(proxy500());

    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.constitution", {}, timing),
    ).rejects.toBeInstanceOf(SpecKitCommandPendingError);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("at project level, ignores another project file and shows the command's own", async () => {
    m.listFiles!.mockResolvedValueOnce(files({ "constitution.md": 1, "tasks.md": 1 }))
      // Someone saves the constitution…
      .mockResolvedValueOnce(files({ "constitution.md": 2, "tasks.md": 1 }))
      // …and then the lost /speckit.tasks saves its own file.
      .mockResolvedValue(files({ "constitution.md": 2, "tasks.md": 2 }));
    m.runCommand!.mockRejectedValue(proxy500());

    const result = await runSpecKitCommandWithRecovery("p1", "speckit.tasks", {}, timing);

    expect(result.artifactName).toBe("tasks.md");
    expect(result.message).toContain("a newer tasks.md was saved");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("a project-level /speckit.specify ignores a changed project file", async () => {
    m.listFiles!.mockResolvedValueOnce(files({ "spec.md": 1 })).mockResolvedValue(
      files({ "spec.md": 2 }),
    );
    m.runCommand!.mockRejectedValue(proxy500());
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.specify", {}, timing),
    ).rejects.toBeInstanceOf(SpecKitCommandPendingError);
  });

  it("in a feature, reads that feature only and ignores an artifact the command does not write", async () => {
    // spec.md is edited by hand while /speckit.tasks runs on f1.
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "spec.md": 1, "tasks.md": 1 }))
      .mockResolvedValueOnce(artifacts({ "spec.md": 2, "tasks.md": 1 }))
      .mockResolvedValue(artifacts({ "spec.md": 2, "tasks.md": 2 }));
    m.runCommand!.mockRejectedValue(proxy500());

    const result = await runSpecKitCommandWithRecovery(
      "p1",
      "speckit.tasks",
      { featureSlug: "f1" },
      timing,
    );

    expect(result.artifacts).toEqual([{ key: "tasks.md" }]);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const call of m.listFeatureArtifacts!.mock.calls) expect(call).toEqual(["p1", "f1"]);
    // No other feature, and no project file, is looked at.
    expect(m.listFeatures).not.toHaveBeenCalled();
    expect(m.listFiles).not.toHaveBeenCalled();
  });
});

describe("leaving the page cancels the recovery", () => {
  it("stops reading once the signal aborts during a wait", async () => {
    const left = new AbortController();
    m.listFeatureArtifacts!.mockResolvedValue(artifacts({ "plan.md": 1 }));
    m.runCommand!.mockRejectedValue(proxy500());
    sleep.mockImplementation(async () => {
      if (sleep.mock.calls.length === 2) left.abort();
    });

    await expect(
      runSpecKitCommandWithRecovery(
        "p1",
        "speckit.plan",
        { featureSlug: "f1" },
        { ...timing, attempts: 10, signal: left.signal },
      ),
    ).rejects.toBeInstanceOf(SpecKitCommandCancelledError);

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenLastCalledWith(7, left.signal);
    // Baseline + the one read before the page was left.
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(2);
  });

  it("does not poll at all when the page was left before the response was lost", async () => {
    const left = new AbortController();
    m.listFeatureArtifacts!.mockResolvedValueOnce(artifacts({ "plan.md": 1 })).mockResolvedValue(
      artifacts({ "plan.md": 2 }),
    );
    m.runCommand!.mockImplementation(async () => {
      left.abort();
      throw proxy500();
    });
    await expect(
      runSpecKitCommandWithRecovery(
        "p1",
        "speckit.plan",
        { featureSlug: "f1" },
        { ...timing, signal: left.signal },
      ),
    ).rejects.toBeInstanceOf(SpecKitCommandCancelledError);
    expect(sleep).not.toHaveBeenCalled();
    expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
  });

  it("returns no recovered result when the page is left during the read that found it", async () => {
    const left = new AbortController();
    m.listFeatureArtifacts!.mockResolvedValueOnce(
      artifacts({ "plan.md": 1 }),
    ).mockImplementationOnce(async () => {
      left.abort();
      return artifacts({ "plan.md": 2 });
    });
    m.runCommand!.mockRejectedValue(proxy500());
    await expect(
      runSpecKitCommandWithRecovery(
        "p1",
        "speckit.plan",
        { featureSlug: "f1" },
        { ...timing, signal: left.signal },
      ),
    ).rejects.toBeInstanceOf(SpecKitCommandCancelledError);
  });

  it("the real wait ends at once when the signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const left = new AbortController();
      m.listFeatureArtifacts!.mockResolvedValue(artifacts({ "plan.md": 1 }));
      m.runCommand!.mockRejectedValue(proxy500());
      const { sleep: _sleep, ...realSleep } = timing;
      const run = runSpecKitCommandWithRecovery(
        "p1",
        "speckit.plan",
        { featureSlug: "f1" },
        { ...realSleep, intervalMs: 5_000, signal: left.signal },
      );
      const outcome = run.then(
        () => "resolved",
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(1);

      left.abort();
      // No timer is advanced: the abort alone ends the wait and clears its timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toBeInstanceOf(SpecKitCommandCancelledError);
      expect(vi.getTimerCount()).toBe(0);
      expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("describeSpecKitError — a lost response", () => {
  it("shows the plain message, not the raw status text or the generic failure", () => {
    const err = new SpecKitCommandPendingError();
    expect(describeSpecKitError(err)).toBe(SPEC_KIT_COMMAND_PENDING);
    expect(describeSpecKitError(err)).toMatch(/may still be running/i);
    expect(describeSpecKitError(err)).not.toMatch(/Internal Server Error/);
    expect(specKitErrorCode(err)).toBeNull();
  });
});
