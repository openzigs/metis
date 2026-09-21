/**
 * Issue #121 — unit tests for TasksPage (tasks component).
 *
 * Covers: tab rendering, loading/empty/data states, expand/collapse,
 * cancel and retry mutations, action errors, and tab switching.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/socket-client", () => ({
  useSocket: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: {
    list: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
  },
}));

import TasksPage from "@/app/(authed)/tasks/page";
import { tasksApi } from "@/lib/scheduler-api";

const listMock = tasksApi.list as unknown as ReturnType<typeof vi.fn>;
const cancelMock = tasksApi.cancel as unknown as ReturnType<typeof vi.fn>;
const retryMock = tasksApi.retry as unknown as ReturnType<typeof vi.fn>;

function makeTask(
  overrides: Partial<{
    id: string;
    type: string;
    trigger: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    payload: string;
    result: string | null;
    errorMessage: string | null;
    progress: number | null;
    createdAt: string;
  }> = {},
) {
  return {
    id: "task-1",
    type: "analysis.run",
    trigger: "manual",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    payload: JSON.stringify({ projectId: "p1" }),
    result: null,
    errorMessage: null,
    progress: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
  cancelMock.mockReset();
  retryMock.mockReset();
  listMock.mockResolvedValue({ items: [] });
});

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <TasksPage />
    </Wrapper>,
  );
}

describe("TasksPage — rendering", () => {
  it("renders all tab buttons", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Waiting/i })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /In flight/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Completed/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Failed/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Cancelled/i })).toBeInTheDocument();
  });

  it("renders page header", () => {
    renderPage();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });

  it("shows loading row while fetching", () => {
    listMock.mockImplementationOnce(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
  });

  it("shows empty state when no tasks", async () => {
    listMock.mockResolvedValueOnce({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No tasks in In flight\./i)).toBeInTheDocument());
  });

  it("renders a task row for each task", async () => {
    listMock.mockResolvedValueOnce({
      items: [
        makeTask({ id: "task-1", type: "analysis.run", status: "running" }),
        makeTask({ id: "task-2", type: "embed.doc", status: "running" }),
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("task-row-task-1")).toBeInTheDocument());
    expect(screen.getByTestId("task-row-task-2")).toBeInTheDocument();
  });

  it("shows task type and trigger in row", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", type: "analysis.run", trigger: "schedule" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("analysis.run")).toBeInTheDocument());
    expect(screen.getByText("schedule")).toBeInTheDocument();
  });
});

describe("TasksPage — tab switching", () => {
  it("switches to Waiting tab and refetches", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ status: "running" })),
    );

    await user.click(screen.getByRole("tab", { name: /Waiting/i }));
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" })),
    );
  });

  it("marks active tab as selected", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /In flight/i })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });
});

describe("TasksPage — expand/collapse", () => {
  it("expands a task row to show payload", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", payload: JSON.stringify({ projectId: "p1" }) })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("expand-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("expand-t1"));
    expect(screen.getByText(/"projectId"/)).toBeInTheDocument();
  });

  it("collapses an expanded task on second click", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", payload: JSON.stringify({ projectId: "p1" }) })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("expand-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("expand-t1"));
    expect(screen.getByText(/"projectId"/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("expand-t1"));
    expect(screen.queryByText(/"projectId"/)).not.toBeInTheDocument();
  });

  it("shows error message when task has errorMessage", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", errorMessage: "Something broke" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("expand-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("expand-t1"));
    expect(screen.getByText("Something broke")).toBeInTheDocument();
  });

  it("shows result when task has a result", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", result: JSON.stringify({ ok: true }) })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("expand-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("expand-t1"));
    expect(screen.getByText(/"ok"/)).toBeInTheDocument();
  });

  it("shows progress when task has progress value", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", progress: 42 })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("expand-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("expand-t1"));
    expect(screen.getByText(/Progress: 42%/i)).toBeInTheDocument();
  });
});

describe("TasksPage — cancel action", () => {
  it("shows Cancel button for running task", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", status: "running" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("cancel-t1")).toBeInTheDocument());
  });

  it("shows Cancel button for pending task", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", status: "pending" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("cancel-t1")).toBeInTheDocument());
  });

  it("calls cancel mutation on Cancel click", async () => {
    cancelMock.mockResolvedValueOnce({});
    listMock.mockResolvedValue({ items: [makeTask({ id: "t1", status: "running" })] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("cancel-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("cancel-t1"));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("t1"));
  });

  it("shows error when cancel fails", async () => {
    cancelMock.mockRejectedValueOnce(new ApiError(409, "Already completed"));
    listMock.mockResolvedValue({ items: [makeTask({ id: "t1", status: "running" })] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("cancel-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("cancel-t1"));
    await waitFor(() => expect(screen.getByText(/Already completed/i)).toBeInTheDocument());
  });
});

describe("TasksPage — retry action", () => {
  it("shows Retry button for failed task", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", status: "failed" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("retry-t1")).toBeInTheDocument());
  });

  it("shows Retry button for cancelled task", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", status: "cancelled" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("retry-t1")).toBeInTheDocument());
  });

  it("does NOT show Retry for running task", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeTask({ id: "t1", status: "running" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("task-row-t1")).toBeInTheDocument());
    expect(screen.queryByTestId("retry-t1")).not.toBeInTheDocument();
  });

  it("calls retry mutation on Retry click", async () => {
    retryMock.mockResolvedValueOnce({});
    listMock.mockResolvedValue({ items: [makeTask({ id: "t1", status: "failed" })] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("retry-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("retry-t1"));
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith("t1"));
  });

  it("shows error when retry fails with non-ApiError", async () => {
    retryMock.mockRejectedValueOnce(new Error("server error"));
    listMock.mockResolvedValue({ items: [makeTask({ id: "t1", status: "failed" })] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("retry-t1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("retry-t1"));
    await waitFor(() => expect(screen.getByText(/Retry failed/i)).toBeInTheDocument());
  });
});
