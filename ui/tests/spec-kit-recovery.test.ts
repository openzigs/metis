/**
 * #1069 — a Spec Kit command whose response was lost is recovered by polling
 * the artifact it was writing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  SPEC_KIT_RECOVERY_ATTEMPTS,
  SPEC_KIT_RECOVERY_INTERVAL_MS,
  SpecKitCommandPendingError,
  isLostResponse,
  newerArtifacts,
  runSpecKitCommandWithRecovery,
} from "@/lib/spec-kit-recovery";

const m = specKitApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** What `apiFetch` throws for the proxy's own 500: status text, no envelope. */
const proxy500 = (): ApiError => new ApiError(500, "Internal Server Error");
const sleep = vi.fn(async () => {});
const timing = { intervalMs: 7, attempts: 3, sleep };

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

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  sleep.mockClear();
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
        "The command finished, but its response was lost. Showing the saved plan.md, research.md.",
      artifacts: [{ key: "plan.md" }, { key: "research.md" }],
    });
    expect(m.listFeatureArtifacts).toHaveBeenCalledWith("p1", "f1");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
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
        "The command finished, but its response was lost. Showing the saved constitution.md.",
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
        'The command finished, but its response was lost. Showing the saved feature "Title of new".',
      feature: created,
    });

    const touched = feature("old", "2026-10-11T00:00:00.000Z");
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

  it("does not poll for a command that saves no artifact", async () => {
    m.runCommand!.mockRejectedValue(proxy500());
    await expect(
      runSpecKitCommandWithRecovery("p1", "speckit.taskstoissues", { featureSlug: "f1" }, timing),
    ).rejects.toBeInstanceOf(SpecKitCommandPendingError);
    expect(m.listFeatureArtifacts).not.toHaveBeenCalled();
    expect(m.listFiles).not.toHaveBeenCalled();
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
      m.runCommand!.mockRejectedValue(proxy500());
      const run = runSpecKitCommandWithRecovery("p1", "speckit.plan", { featureSlug: "f1" });
      await vi.advanceTimersByTimeAsync(SPEC_KIT_RECOVERY_INTERVAL_MS - 1);
      expect(m.listFeatureArtifacts).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await run).artifacts).toEqual([{ key: "plan.md" }]);
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
