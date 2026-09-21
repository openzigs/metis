/**
 * Issue #425 (Epic #406) — canonical terminal-toast utility tests.
 *
 * The de-dup heart of #425: a process-wide, `jobId`-keyed guard that guarantees
 * EXACTLY ONE terminal toast per op no matter how many observers (a detail
 * surface + the global header layer + a bus re-delivery on reconnect) see the
 * same terminal event. Covers:
 *  - success text = the event's human `message` (preserves the Spec Kit
 *    grounded-completion line VERBATIM),
 *  - failure text = the server's already-generic `error` (no raw error leak,
 *    #254 / OWASP), with a user-safe fallback,
 *  - non-terminal / malformed events are ignored,
 *  - the NO-DUPLICATE-TOAST invariant across repeated/cross-observer calls,
 *  - `claimTerminalToast` reserves a job without toasting (overview / Spec Kit
 *    callback path).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import type { JobLifecycleEvent } from "@metis/shared";
import {
  fireTerminalToast,
  claimTerminalToast,
  terminalToastText,
  isTerminalJobStatus,
  GENERIC_SUCCESS_TOAST,
  GENERIC_FAILURE_TOAST,
  __resetTerminalToastsForTests,
} from "@/lib/terminal-toast";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const lifecycle = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "doc-generation",
  jobId: "job-1",
  projectId: "p1",
  status: "completed",
  ts: 1,
  ...over,
});

beforeEach(() => {
  __resetTerminalToastsForTests();
  vi.clearAllMocks();
});

describe("isTerminalJobStatus", () => {
  it("is true only for completed/failed", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("started")).toBe(false);
    expect(isTerminalJobStatus("progress")).toBe(false);
  });
});

describe("terminalToastText", () => {
  it("uses the event message verbatim on completion (Spec Kit grounded line)", () => {
    const grounded = "Generated spec.md (v3) — grounded on 8 retrieved chunks.";
    const result = terminalToastText(lifecycle({ status: "completed", message: grounded }));
    expect(result).toEqual({ kind: "success", text: grounded });
  });

  it("falls back to a generic success label when message is absent", () => {
    expect(terminalToastText(lifecycle({ status: "completed", message: undefined }))).toEqual({
      kind: "success",
      text: GENERIC_SUCCESS_TOAST,
    });
  });

  it("uses the event error on failure (already the server's user-safe message)", () => {
    const generic = "Documentation generation failed. Please try again.";
    expect(terminalToastText(lifecycle({ status: "failed", error: generic }))).toEqual({
      kind: "error",
      text: generic,
    });
  });

  it("falls back to a generic failure label when error is absent (no raw leak)", () => {
    expect(terminalToastText(lifecycle({ status: "failed", error: undefined }))).toEqual({
      kind: "error",
      text: GENERIC_FAILURE_TOAST,
    });
  });
});

describe("fireTerminalToast", () => {
  it("fires a success toast on completion and returns true", () => {
    const fired = fireTerminalToast(lifecycle({ status: "completed", message: "All done." }));
    expect(fired).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("All done.");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("fires an error toast on failure with the generic server message", () => {
    fireTerminalToast(
      lifecycle({ jobId: "j-fail", status: "failed", error: "Analysis failed. Please try again." }),
    );
    expect(toast.error).toHaveBeenCalledWith("Analysis failed. Please try again.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("preserves the Spec Kit grounded-completion line byte-for-byte", () => {
    const grounded = "Generated plan.md (v2) — grounded on 12 retrieved chunks.";
    fireTerminalToast(
      lifecycle({ jobId: "sk-1", kind: "spec-kit", status: "completed", message: grounded }),
    );
    expect(toast.success).toHaveBeenCalledWith(grounded);
  });

  it("NO DUPLICATE TOAST: the same jobId's terminal event toasts at most once", () => {
    const ev = lifecycle({ jobId: "dup", status: "completed", message: "Done." });
    expect(fireTerminalToast(ev)).toBe(true);
    // Second observer (e.g. the global layer after a surface, or a reconnect
    // re-delivery) must be a no-op.
    expect(fireTerminalToast(ev)).toBe(false);
    expect(fireTerminalToast({ ...ev })).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("toasts distinct jobs independently", () => {
    fireTerminalToast(lifecycle({ jobId: "a", status: "completed", message: "A done" }));
    fireTerminalToast(lifecycle({ jobId: "b", status: "failed", error: "B failed" }));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("ignores non-terminal events (started/progress) without toasting", () => {
    expect(fireTerminalToast(lifecycle({ status: "started" }))).toBe(false);
    expect(fireTerminalToast(lifecycle({ status: "progress", progress: 50 }))).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ignores malformed events (null / missing jobId)", () => {
    expect(fireTerminalToast(null)).toBe(false);
    expect(fireTerminalToast(undefined)).toBe(false);
    expect(fireTerminalToast({ status: "completed" } as unknown as JobLifecycleEvent)).toBe(false);
    expect(fireTerminalToast(lifecycle({ jobId: "" }))).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("claimTerminalToast", () => {
  it("reserves a jobId without firing a toast (surface-callback path)", () => {
    expect(claimTerminalToast("claimed-1")).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a later fireTerminalToast for a claimed job is a no-op (one toast per op)", () => {
    expect(claimTerminalToast("claimed-2")).toBe(true);
    // The surface already showed its own (grounded) toast; the global layer must
    // not double it when it later observes the same job's terminal event.
    expect(
      fireTerminalToast(lifecycle({ jobId: "claimed-2", status: "completed", message: "x" })),
    ).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("returns false for an already-claimed job and for empty input", () => {
    expect(claimTerminalToast("claimed-3")).toBe(true);
    expect(claimTerminalToast("claimed-3")).toBe(false);
    expect(claimTerminalToast(null)).toBe(false);
    expect(claimTerminalToast(undefined)).toBe(false);
  });
});
