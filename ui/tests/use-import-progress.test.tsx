/**
 * Live import-progress hook — Issue #424 (Epic #406).
 *
 * Covers the AC for the import page's live progress, exercised through the
 * coverage-counted hook (`src/app/.../import/page.tsx` is coverage-EXCLUDED, so
 * the testable logic lives here):
 *   - progress-rendered-during-run: `started` → `progress` events flow into an
 *     `ImportProgressView` that drives the `<JobProgress>` bar;
 *   - terminal-toast (success + failure): the unified `useJobToast` consumer
 *     fires sonner exactly once, with the server's GENERIC failure message
 *     (#254 — never raw error detail);
 *   - poll-demotion: on the terminal transition the hook invalidates the import
 *     caches so the history list converges on PUSH (the 10s poll is a fallback).
 *
 * Socket + sonner are mocked exactly as the `use-connector-events` precedent.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { JobLifecycleEvent } from "@metis/shared";
import { importProgressView, useImportProgress } from "@/hooks/use-import-progress";
import { __resetTerminalToastsForTests } from "@/lib/terminal-toast";
import { makeWrapper } from "./test-utils";

// `vi.hoisted` so these mock refs exist when the hoisted `vi.mock` factories run.
const { mockOn, mockEmit, mockSocket, toast, invalidateSpy } = vi.hoisted(() => {
  const on = vi.fn();
  const off = vi.fn();
  const emit = vi.fn();
  return {
    mockOn: on,
    mockEmit: emit,
    mockSocket: { on, off, emit, connected: true },
    toast: { success: vi.fn(), error: vi.fn() },
    invalidateSpy: vi.fn(),
  };
});

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => mockSocket,
}));

vi.mock("sonner", () => ({ toast }));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return { ...actual, useQueryClient: () => ({ invalidateQueries: invalidateSpy }) };
});

beforeEach(() => {
  // #425 — terminal toasts dedupe via a MODULE-LEVEL `jobId` guard now, so reset
  // it between cases or the success test's `run-1` would suppress the failure
  // test's toast (both reuse the same job id).
  __resetTerminalToastsForTests();
  vi.clearAllMocks();
});

function event(partial: Partial<JobLifecycleEvent>): JobLifecycleEvent {
  return {
    kind: "import-sync",
    jobId: "run-1",
    projectId: "proj-1",
    status: "progress",
    ts: Date.now(),
    ...partial,
  };
}

/** Drive the latest `job:lifecycle` handler the hook registered. */
function emitLifecycle(data: JobLifecycleEvent) {
  const handler = mockOn.mock.calls.find((c) => c[0] === "job:lifecycle")?.[1];
  expect(handler).toBeDefined();
  act(() => handler!(data));
}

describe("importProgressView (#424 pure mapping)", () => {
  it("returns null when there is no event", () => {
    expect(importProgressView(null)).toBeNull();
  });

  it("maps a started event to an indeterminate working bar", () => {
    const v = importProgressView(event({ status: "started", message: "Importing from GitHub…" }));
    expect(v).toEqual({
      progress: null,
      message: "Importing from GitHub…",
      indeterminate: true,
      done: false,
    });
  });

  it("maps a numeric progress event to a determinate bar", () => {
    const v = importProgressView(
      event({ status: "progress", progress: 40, message: "Fetched 4/10 issues" }),
    );
    expect(v).toMatchObject({ progress: 40, indeterminate: false, done: false });
  });

  it("treats progress=0 (total unknown) as indeterminate — no misleading 0%", () => {
    const v = importProgressView(
      event({ status: "progress", progress: 0, message: "Fetched 3 issues" }),
    );
    expect(v).toMatchObject({ progress: null, indeterminate: true, done: false });
  });

  it("marks completed and failed as done", () => {
    expect(
      importProgressView(event({ status: "completed", message: "Imported 5 new" })),
    ).toMatchObject({
      done: true,
    });
    expect(importProgressView(event({ status: "failed", error: "x" }))).toMatchObject({
      done: true,
    });
  });

  it("falls back to a generic 'Working…' label for a non-started event without a message", () => {
    const v = importProgressView(event({ status: "progress", progress: 25, message: undefined }));
    expect(v).toMatchObject({ message: "Working…", progress: 25 });
  });

  it("falls back to 'Importing…' for a started event without a message", () => {
    const v = importProgressView(event({ status: "started", message: undefined }));
    expect(v).toMatchObject({ message: "Importing…", indeterminate: true });
  });
});

describe("useImportProgress (#424 live run)", () => {
  it("subscribes to the active run's job room and renders progress during the run", () => {
    const { result } = renderHook(() => useImportProgress("run-1", "proj-1"), {
      wrapper: makeWrapper({ withAuth: false }),
    });

    expect(mockEmit).toHaveBeenCalledWith("subscribe:job", { jobId: "run-1" });

    emitLifecycle(event({ status: "started", message: "Importing from GitHub…" }));
    expect(result.current).toMatchObject({ indeterminate: true, done: false });

    emitLifecycle(event({ status: "progress", progress: 50, message: "Fetched 5/10 issues" }));
    expect(result.current).toMatchObject({
      progress: 50,
      message: "Fetched 5/10 issues",
      done: false,
    });
  });

  it("fires a success toast and refreshes import caches on completion (poll demoted to fallback)", () => {
    renderHook(() => useImportProgress("run-1", "proj-1"), {
      wrapper: makeWrapper({ withAuth: false }),
    });

    emitLifecycle(event({ status: "completed", message: "Imported 5 new, 2 updated" }));

    expect(toast.success).toHaveBeenCalledWith("Imported 5 new, 2 updated");
    expect(toast.error).not.toHaveBeenCalled();
    // PUSH-driven refresh: both import caches invalidated on the terminal event.
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["imports", "sources", "proj-1"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["imports", "runs", "proj-1", "all"] }),
    );
  });

  it("fires a failure toast with the server's generic message — no raw detail", () => {
    renderHook(() => useImportProgress("run-1", "proj-1"), {
      wrapper: makeWrapper({ withAuth: false }),
    });

    emitLifecycle(event({ status: "failed", error: "The import sync failed. Please try again." }));

    expect(toast.error).toHaveBeenCalledWith("The import sync failed. Please try again.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("subscribes to nothing when there is no active run", () => {
    renderHook(() => useImportProgress(null, "proj-1"), {
      wrapper: makeWrapper({ withAuth: false }),
    });
    expect(mockEmit).not.toHaveBeenCalledWith("subscribe:job", expect.anything());
  });
});
