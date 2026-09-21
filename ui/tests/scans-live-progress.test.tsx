/**
 * Scans list page — live task-progress (Issue #422 / Epic #406).
 *
 * The scans page used to merely poll every 8s and show a status badge. It now
 * subscribes to the EXISTING `task:{taskId}` room for in-flight scans and renders
 * live progress. These tests cover the three required scenarios:
 *   1. progress-rendered-from-task-events
 *   2. poll-fallback-when-no-socket (no taskId / no socket → no subscribe, row still shown)
 *   3. unauthorized-subscribe-graceful (server rejects subscribe:task → no crash, poll drives UI)
 * plus the terminal-status toast + refetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import type { TaskProgressEvent, TaskStatusEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";

const PROJECT_ID = "proj_test";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: PROJECT_ID })),
}));

// ── fake socket (mirrors use-job-events.test.tsx) ───────────────────────────
type Handler = (data: unknown) => void;
function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const emit = vi.fn();
  const socket = {
    emit,
    on: vi.fn((name: string, fn: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    }),
    off: vi.fn((name: string, fn: Handler) => {
      handlers.get(name)?.delete(fn);
    }),
  };
  const fire = (name: string, data: unknown) => {
    handlers.get(name)?.forEach((fn) => fn(data));
  };
  return { socket, fire, emit };
}
let fake = makeFakeSocket();
// `null` socket simulates a not-yet-connected / disabled realtime client.
let socketValue: ReturnType<typeof makeFakeSocket>["socket"] | null = fake.socket;

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => socketValue,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastBase = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastBase(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  }),
}));

vi.mock("@/lib/scanner-api", () => ({
  scannerApi: {
    listProjectScans: vi.fn(),
  },
}));
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: {
    list: vi.fn(async () => []),
  },
}));

import { scannerApi } from "@/lib/scanner-api";
import ScansListPage from "@/app/(authed)/projects/[id]/scans/page";

const mockListScans = vi.mocked(scannerApi.listProjectScans);

function makeScan(over: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    projectId: PROJECT_ID,
    repoConnectionId: "repo-1",
    commitSha: "abcdef1234567890",
    status: "running",
    mode: "both",
    startedAt: null,
    completedAt: null,
    totalSymbols: 0,
    scannedSymbols: 0,
    totalTokens: 0,
    costCents: 0,
    budgetCapTokens: 2_000_000,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    findingCount: 0,
    taskId: "task-1",
    ...over,
  };
}

const progress = (over: Partial<TaskProgressEvent>): TaskProgressEvent => ({
  taskId: "task-1",
  step: "scanner.scan.symbol",
  current: 4,
  total: 10,
  progress: 40,
  ts: 1,
  ...over,
});
const status = (over: Partial<TaskStatusEvent>): TaskStatusEvent => ({
  taskId: "task-1",
  type: "scanner.run-scan",
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  ts: 1,
  ...over,
});

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ScansListPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  fake = makeFakeSocket();
  socketValue = fake.socket;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("ScansListPage — live progress (#422)", () => {
  it("subscribes to the in-flight scan's task room and renders progress from task:progress", async () => {
    mockListScans.mockResolvedValue([makeScan()] as never);
    renderPage();

    await screen.findByTestId("scan-row-scan-1");
    await waitFor(() => {
      expect(fake.emit).toHaveBeenCalledWith("subscribe:task", { taskId: "task-1" });
    });

    act(() => fake.fire("task:progress", progress({ progress: 40, current: 4, total: 10 })));

    const bar = await screen.findByTestId("scan-progress-bar");
    expect(bar.style.width).toBe("40%");
    expect(screen.getByTestId("scan-progress-phase").textContent).toMatch(/scanning symbols/i);
    expect(screen.getByTestId("scan-progress-count").textContent).toBe("4/10");
    const role = screen.getByRole("progressbar");
    expect(role.getAttribute("aria-valuenow")).toBe("40");
  });

  it("does NOT subscribe for a terminal scan (no live task id) — poll drives the row", async () => {
    mockListScans.mockResolvedValue([
      makeScan({ status: "completed", taskId: null, findingCount: 3 }),
    ] as never);
    renderPage();

    await screen.findByTestId("scan-row-scan-1");
    // Terminal scans carry no taskId → the hook must not subscribe.
    expect(fake.emit).not.toHaveBeenCalledWith("subscribe:task", expect.anything());
    expect(screen.queryByTestId("scan-progress")).toBeNull();
    // The row still renders its status + findings from the polled list.
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("falls back to the poll with no console errors when the socket is unavailable", async () => {
    socketValue = null; // realtime not connected
    mockListScans.mockResolvedValue([makeScan()] as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage();

    await screen.findByTestId("scan-row-scan-1");
    // No socket → no subscribe, no progress UI, but the row renders fine.
    expect(fake.emit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("scan-progress")).toBeNull();
    expect(screen.getByText("running")).toBeTruthy();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("stays graceful when subscribe:task is rejected (unauthorized) — no progress, no crash", async () => {
    mockListScans.mockResolvedValue([makeScan()] as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage();

    await screen.findByTestId("scan-row-scan-1");
    await waitFor(() => {
      expect(fake.emit).toHaveBeenCalledWith("subscribe:task", { taskId: "task-1" });
    });
    // Server rejects → it emits `auth:error` (handled by the socket client) and
    // simply never sends task:progress. The row must keep rendering from the poll.
    act(() => fake.fire("auth:error", { message: "FORBIDDEN: subscribe:task requires task.read" }));
    expect(screen.queryByTestId("scan-progress")).toBeNull();
    expect(screen.getByText("running")).toBeTruthy();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("toasts success and refetches on a terminal completed task:status", async () => {
    mockListScans.mockResolvedValue([makeScan()] as never);
    renderPage();

    await screen.findByTestId("scan-row-scan-1");
    await waitFor(() => {
      expect(fake.emit).toHaveBeenCalledWith("subscribe:task", { taskId: "task-1" });
    });

    const callsBefore = mockListScans.mock.calls.length;
    act(() => fake.fire("task:status", status({ status: "completed" })));

    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/finished/i));
    await waitFor(() => {
      expect(mockListScans.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("toasts an error on a terminal failed task:status", async () => {
    mockListScans.mockResolvedValue([makeScan()] as never);
    renderPage();

    await screen.findByTestId("scan-row-scan-1");
    await waitFor(() => {
      expect(fake.emit).toHaveBeenCalledWith("subscribe:task", { taskId: "task-1" });
    });
    act(() => fake.fire("task:status", status({ status: "failed", errorMessage: "boom" })));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/failed/i));
  });
});
