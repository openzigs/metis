/**
 * Spec Kit commands — async job + grounded-completion preservation (Epic #406 / #423).
 *
 * The `/commands/:cmd` route now runs the LLM dispatch under the unified
 * `job:lifecycle` bus (kind `spec-kit`), minting a `jobId` and streaming
 * progress, while still returning the full command result synchronously so the
 * precise success payload AND error contract are preserved. These tests cover
 * the per-op AC:
 *   - enqueue-returns-jobid: the route mints a jobId and the response carries it
 *     (asserted in `spec-kit-route.test.ts`).
 *   - progress-emitted: the worker streams `started` → `progress` → `completed`.
 *   - spec-kit-completion-line-preserved: the grounded-completion line
 *     ("Generated spec.md (v3) … grounded on N retrieved chunks") is threaded
 *     VERBATIM into the terminal `completed` message — NOT regressed.
 *   - terminal-toast (failure): any error emits a GENERIC user-safe `failed`
 *     event (#254 / OWASP — no raw error/credential detail leaked) AND re-throws
 *     so the route maps it to the precise 4xx/5xx (never a generic toast alone).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { jobEvents } = vi.hoisted(() => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    lifecycle: vi.fn(),
    docSection: vi.fn(),
  },
}));
vi.mock("../lib/socket/job-events.js", () => ({
  jobEvents,
  genericFailureMessage: (kind: string) => `GENERIC:${kind}`,
}));

import { runSpecKitCommandJob, extractCompletionMessage } from "./spec-kit.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractCompletionMessage", () => {
  it("returns the result's message when present (grounded-completion line)", () => {
    const msg = "Generated spec.md (v3) in 1240 tokens — grounded on 8 retrieved chunks.";
    expect(extractCompletionMessage({ message: msg }, "fallback")).toBe(msg);
  });

  it("falls back when there is no usable message", () => {
    expect(extractCompletionMessage({}, "fallback")).toBe("fallback");
    expect(extractCompletionMessage(null, "fallback")).toBe("fallback");
    expect(extractCompletionMessage({ message: "" }, "fallback")).toBe("fallback");
    expect(extractCompletionMessage({ message: 7 }, "fallback")).toBe("fallback");
  });
});

describe("runSpecKitCommandJob — lifecycle streaming", () => {
  it("emits started → progress → completed (progress + success toast)", async () => {
    const dispatch = vi.fn(async () => ({
      command: "specify",
      artifactName: "spec.md",
      message: "Generated spec.md (v1) in 900 tokens — grounded on 4 retrieved chunks.",
      tokensUsed: 900,
    }));

    await runSpecKitCommandJob("job-1", "p1", "/specify", dispatch);

    expect(jobEvents.started).toHaveBeenCalledWith("spec-kit", "job-1", "p1", expect.any(String));
    expect(jobEvents.progress).toHaveBeenCalledWith(
      "spec-kit",
      "job-1",
      "p1",
      50,
      expect.any(String),
    );
    expect(jobEvents.completed).toHaveBeenCalledTimes(1);
    expect(jobEvents.failed).not.toHaveBeenCalled();
  });

  it("PRESERVES the grounded-completion line as the terminal completed message", async () => {
    // The grounded-completion string is the EXACT line spec-kit commands return.
    const grounded = "Generated spec.md (v3) in 1320 tokens — grounded on 8 retrieved chunks.";
    const dispatch = vi.fn(async () => ({
      command: "specify",
      artifactName: "spec.md",
      message: grounded,
      tokensUsed: 1320,
    }));

    await runSpecKitCommandJob("job-2", "p1", "/specify", dispatch);

    // The terminal message is the grounded line, byte-for-byte — not a generic
    // "completed" label and not the failure message.
    expect(jobEvents.completed).toHaveBeenCalledWith("spec-kit", "job-2", "p1", grounded);
  });

  it("also preserves the UNGROUNDED completion line verbatim", async () => {
    const ungrounded =
      "Generated spec.md (v1) in 700 tokens — ungrounded (no project knowledge retrieved).";
    const dispatch = vi.fn(async () => ({ message: ungrounded }));
    await runSpecKitCommandJob("job-3", "p1", "/specify", dispatch);
    expect(jobEvents.completed).toHaveBeenCalledWith("spec-kit", "job-3", "p1", ungrounded);
  });

  it("emits a GENERIC failed message on error — no raw detail leaked (failure toast)", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("provider key AKIA-SECRET rejected by bedrock endpoint");
    });
    // The job emits a generic failed event for the bus, then re-throws so the
    // route can map the precise error — assert the generic event regardless.
    await expect(runSpecKitCommandJob("job-4", "p1", "/plan", dispatch)).rejects.toThrow();
    expect(jobEvents.failed).toHaveBeenCalledWith("spec-kit", "job-4", "p1", "GENERIC:spec-kit");
    const leaked = jobEvents.failed.mock.calls[0][3] as string;
    expect(leaked).not.toContain("AKIA");
    expect(leaked).not.toContain("bedrock");
    expect(jobEvents.completed).not.toHaveBeenCalled();
  });

  it("re-throws the ORIGINAL error so the route maps it to a precise status code", async () => {
    // The grounded HAPPY-path message is what #423 preserves; the rich error
    // contract (budget/safety/provider/gate → proper 4xx) is preserved by
    // re-throwing the original error rather than swallowing it into a 202.
    const original = new Error("Project monthly budget exceeded");
    const dispatch = vi.fn(async () => {
      throw original;
    });
    await expect(runSpecKitCommandJob("job-5", "p1", "/tasks", dispatch)).rejects.toBe(original);
  });
});
