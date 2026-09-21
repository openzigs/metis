/**
 * Issue #425 (Epic #406) — behavioral list-view terminal-toast flow.
 *
 * End-to-end-ish test of the de-dup LAYER through the REAL component that mounts
 * it: `<ActiveJobsIndicator />` (header-mounted, one per app) wires the real
 * `useGlobalJobToasts` to a fake socket. This proves the headline AC against a
 * mounted surface, not just the hook in isolation:
 *
 *  - FAILURE-TOAST-ON-LIST: a doc-gen / analysis op the user is NOT detail-viewing
 *    fails on the bus → the user (watching a LIST whose socket is in the project
 *    room) gets the generic error toast.
 *  - SUCCESS-TOAST-ON-COMPLETE: a completed op toasts with its message.
 *  - SPEC-KIT GROUNDED LINE preserved verbatim through the global layer.
 *  - NO DUPLICATE TOAST: a re-delivered terminal event toasts once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { toast } from "sonner";
import type { JobLifecycleEvent } from "@metis/shared";
import { __resetTerminalToastsForTests } from "@/lib/terminal-toast";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The indicator's drawer uses Radix Sheet; we never open it here, so the default
// store (empty job list) keeps it rendered as null — we only care about the
// global terminal-toast side effect it mounts.
type Handler = (data: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((name: string, fn: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    }),
    off: vi.fn((name: string, fn: Handler) => {
      handlers.get(name)?.delete(fn);
    }),
  };
  const fire = (name: string, data: unknown) => handlers.get(name)?.forEach((fn) => fn(data));
  return { socket, fire };
}

let fake = makeFakeSocket();

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => fake.socket,
}));

import { ActiveJobsIndicator } from "@/components/realtime/active-jobs-indicator";

const lifecycle = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "doc-generation",
  jobId: "job-1",
  projectId: "p1",
  status: "completed",
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  __resetTerminalToastsForTests();
  vi.clearAllMocks();
});

describe("global terminal-toast flow (via the header indicator)", () => {
  it("FAILURE-TOAST-ON-LIST: surfaces a failed doc-gen the user never opened", () => {
    render(<ActiveJobsIndicator />);
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({
          jobId: "doc-99",
          status: "failed",
          error: "Documentation generation failed. Please try again.",
        }),
      ),
    );
    expect(toast.error).toHaveBeenCalledWith("Documentation generation failed. Please try again.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("SUCCESS-TOAST-ON-COMPLETE: surfaces a completed analysis from the bus", () => {
    render(<ActiveJobsIndicator />);
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({
          jobId: "an-5",
          kind: "analysis",
          status: "completed",
          message: "Analysis complete",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Analysis complete");
  });

  it("preserves the Spec Kit grounded-completion line verbatim through the global layer", () => {
    const grounded = "Generated spec.md (v4) — grounded on 9 retrieved chunks.";
    render(<ActiveJobsIndicator />);
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ jobId: "sk-9", kind: "spec-kit", status: "completed", message: grounded }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith(grounded);
  });

  it("NO DUPLICATE TOAST: a re-delivered terminal event toasts once", () => {
    render(<ActiveJobsIndicator />);
    const ev = lifecycle({
      jobId: "redeliver-1",
      status: "failed",
      error: "It failed. Please try again.",
    });
    act(() => fake.fire("job:lifecycle", ev));
    act(() => fake.fire("job:lifecycle", ev));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
