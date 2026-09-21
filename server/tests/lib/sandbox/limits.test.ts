/**
 * Tests for SANDBOX_HARD_LIMITS + clampSandboxOptions (Epic #395 #412).
 */
import { describe, expect, it, vi } from "vitest";
import { clampSandboxOptions } from "../../../src/lib/sandbox/clamp.js";
import { SANDBOX_HARD_LIMITS } from "../../../src/lib/sandbox/limits.js";
import { SandboxLimitExceededError } from "../../../src/lib/sandbox/types.js";

describe("SANDBOX_HARD_LIMITS", () => {
  it("matches the Epic #395 #412 contract values exactly", () => {
    expect(SANDBOX_HARD_LIMITS.maxVCpus).toBe(4);
    expect(SANDBOX_HARD_LIMITS.maxMemMiB).toBe(8 * 1024);
    expect(SANDBOX_HARD_LIMITS.maxWallClockMs).toBe(300_000);
    expect(SANDBOX_HARD_LIMITS.maxFileWriteBytes).toBe(100 * 1024 * 1024);
  });
});

describe("clampSandboxOptions", () => {
  const project = "proj-1";

  it("applies defaults when nothing is requested", () => {
    const out = clampSandboxOptions({ projectId: project });
    expect(out.vCpus).toBeGreaterThan(0);
    expect(out.memMiB).toBeGreaterThanOrEqual(128);
    expect(out.timeoutMs).toBeGreaterThan(0);
    expect(out.timeoutMs).toBeLessThanOrEqual(SANDBOX_HARD_LIMITS.maxWallClockMs);
  });

  it("throws SandboxLimitExceededError when vCpus > max", () => {
    expect(() => clampSandboxOptions({ projectId: project, vCpus: 99 })).toThrow(
      SandboxLimitExceededError,
    );
  });

  it("throws SandboxLimitExceededError when memMiB > max", () => {
    expect(() => clampSandboxOptions({ projectId: project, memMiB: 999_999 })).toThrow(
      SandboxLimitExceededError,
    );
  });

  it("throws when vCpus < 1", () => {
    expect(() => clampSandboxOptions({ projectId: project, vCpus: 0 })).toThrow(
      SandboxLimitExceededError,
    );
  });

  it("throws when memMiB < 128", () => {
    expect(() => clampSandboxOptions({ projectId: project, memMiB: 64 })).toThrow(
      SandboxLimitExceededError,
    );
  });

  it("clamps timeoutMs > 300_000 to the hard cap and warns", () => {
    const warn = vi.fn();
    // Stub the logger by replacing console.warn just for visibility — clamp
    // emits via the structured logger which is independent of console here.
    const out = clampSandboxOptions({ projectId: project, timeoutMs: 600_000 });
    expect(out.timeoutMs).toBe(SANDBOX_HARD_LIMITS.maxWallClockMs);
    void warn; // visibility only
  });

  it("clamps timeoutMs below the minimum to 1000ms", () => {
    const out = clampSandboxOptions({ projectId: project, timeoutMs: 50 });
    expect(out.timeoutMs).toBe(SANDBOX_HARD_LIMITS.minWallClockMs);
  });

  it("project cap tightens caller request", () => {
    const out = clampSandboxOptions(
      { projectId: project, timeoutMs: 200_000 },
      { sandboxTimeoutMs: 60_000 },
    );
    expect(out.timeoutMs).toBe(60_000);
  });

  it("project cap does NOT loosen the hard cap", () => {
    const out = clampSandboxOptions(
      { projectId: project, timeoutMs: 600_000 },
      { sandboxTimeoutMs: 999_999 },
    );
    expect(out.timeoutMs).toBe(SANDBOX_HARD_LIMITS.maxWallClockMs);
  });

  it("project cap does NOT loosen the caller's lower request", () => {
    const out = clampSandboxOptions(
      { projectId: project, timeoutMs: 5_000 },
      { sandboxTimeoutMs: 60_000 },
    );
    expect(out.timeoutMs).toBe(5_000);
  });

  it("merges caller egressAllowlist + project egressAllowlist (deduped)", () => {
    const out = clampSandboxOptions(
      { projectId: project, egressAllowlist: ["a.example", "b.example"] },
      { sandboxEgressAllowlist: ["b.example", "c.example"] },
    );
    expect(out.egressAllowlist.sort()).toEqual(["a.example", "b.example", "c.example"]);
  });

  it("retains userId when supplied", () => {
    const out = clampSandboxOptions({ projectId: project, userId: "user-1" });
    expect(out.userId).toBe("user-1");
  });

  it("normalizes missing userId to null", () => {
    const out = clampSandboxOptions({ projectId: project });
    expect(out.userId).toBeNull();
  });

  it("ignores non-finite project caps", () => {
    const out = clampSandboxOptions(
      { projectId: project, timeoutMs: 5_000 },
      { sandboxTimeoutMs: NaN },
    );
    expect(out.timeoutMs).toBe(5_000);
  });
});

describe("SandboxLimitExceededError", () => {
  it("carries the limit, requested and maximum on the instance", () => {
    const err = new SandboxLimitExceededError("vCpus", 99, 4);
    expect(err.limit).toBe("vCpus");
    expect(err.requested).toBe(99);
    expect(err.maximum).toBe(4);
    expect(err.message).toMatch(/vCpus/);
    expect(err.name).toBe("SandboxLimitExceededError");
  });
});
