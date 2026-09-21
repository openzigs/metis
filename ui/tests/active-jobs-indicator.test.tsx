/**
 * Epic #406 (#420) — global active-jobs indicator tests.
 *
 * Verifies the header indicator + drawer:
 *  - hidden entirely when no jobs are running,
 *  - shows "N jobs running" with the right count + accessible live region,
 *  - opens a drawer listing active jobs (kind, project, progress),
 *  - a NON-doc-gen kind (scan / analysis) also appears (any JobKind),
 *  - clears (unmounts) when all jobs reach a terminal state.
 *
 * The `useActiveJobs` store itself is exercised in use-active-jobs.test.tsx; here
 * we mock it so we can drive the component through precise states.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ActiveJob } from "@/hooks/use-active-jobs";

const useActiveJobsMock = vi.fn<() => ActiveJob[]>();

vi.mock("@/hooks/use-active-jobs", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-active-jobs")>("@/hooks/use-active-jobs");
  return { ...actual, useActiveJobs: () => useActiveJobsMock() };
});

// #425 — the indicator now also mounts the global terminal-toast consumer, which
// touches the real socket singleton. Stub it here so these UI-focused cases don't
// open a real connection; its behaviour is covered in use-global-job-toasts.test.tsx
// and global-terminal-toast-flow.test.tsx.
vi.mock("@/hooks/use-global-job-toasts", () => ({
  useGlobalJobToasts: vi.fn(),
}));

import { ActiveJobsIndicator } from "@/components/realtime/active-jobs-indicator";

const job = (over: Partial<ActiveJob> = {}): ActiveJob => ({
  jobId: "job-1",
  kind: "doc-generation",
  projectId: "p1",
  progress: 40,
  ts: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useActiveJobsMock.mockReturnValue([]);
});

describe("<ActiveJobsIndicator />", () => {
  it("renders nothing when no jobs are running", () => {
    useActiveJobsMock.mockReturnValue([]);
    const { container } = render(<ActiveJobsIndicator />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("active-jobs-indicator")).not.toBeInTheDocument();
  });

  it("shows the running count in an accessible live region", () => {
    useActiveJobsMock.mockReturnValue([job({ jobId: "a" }), job({ jobId: "b", kind: "scan" })]);
    render(<ActiveJobsIndicator />);

    const region = screen.getByTestId("active-jobs-indicator");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("active-jobs-count")).toHaveTextContent("2 jobs running");
  });

  it("uses the singular 'job' for exactly one active job", () => {
    useActiveJobsMock.mockReturnValue([job()]);
    render(<ActiveJobsIndicator />);
    expect(screen.getByTestId("active-jobs-count")).toHaveTextContent("1 job running");
  });

  it("opens a drawer listing active jobs with kind, project and progress", () => {
    useActiveJobsMock.mockReturnValue([
      job({ jobId: "a", kind: "doc-generation", projectId: "proj-A", progress: 25 }),
    ]);
    render(<ActiveJobsIndicator />);

    fireEvent.click(screen.getByTestId("active-jobs-button"));

    const drawer = screen.getByTestId("active-jobs-drawer");
    const row = within(drawer).getByTestId("active-job-a");
    expect(within(row).getByText("Documentation")).toBeInTheDocument();
    expect(within(row).getByText(/proj-A/)).toBeInTheDocument();
    expect(within(row).getByText("25%")).toBeInTheDocument();
  });

  it("lists a NON-doc-gen kind (scan) in the drawer — any JobKind, not just doc-gen", () => {
    useActiveJobsMock.mockReturnValue([
      job({ jobId: "scan-1", kind: "scan", projectId: "proj-Z", progress: 60 }),
      job({ jobId: "an-1", kind: "analysis", projectId: "proj-Y", progress: 10 }),
    ]);
    render(<ActiveJobsIndicator />);

    fireEvent.click(screen.getByTestId("active-jobs-button"));
    const drawer = screen.getByTestId("active-jobs-drawer");
    expect(within(drawer).getByText("Security scan")).toBeInTheDocument();
    expect(within(drawer).getByText("Analysis")).toBeInTheDocument();
  });

  it("shows a spinner (no %) for a job without a numeric progress", () => {
    useActiveJobsMock.mockReturnValue([
      job({ jobId: "x", progress: undefined, message: "Working" }),
    ]);
    render(<ActiveJobsIndicator />);
    fireEvent.click(screen.getByTestId("active-jobs-button"));
    const row = screen.getByTestId("active-job-x");
    expect(within(row).queryByText("%", { exact: false })).not.toBeInTheDocument();
    expect(within(row).getByText("Working")).toBeInTheDocument();
  });

  it("clears (renders nothing) once all jobs reach a terminal state", () => {
    useActiveJobsMock.mockReturnValue([job()]);
    const { rerender } = render(<ActiveJobsIndicator />);
    expect(screen.getByTestId("active-jobs-indicator")).toBeInTheDocument();

    // All jobs finished → store returns an empty list → indicator disappears.
    useActiveJobsMock.mockReturnValue([]);
    rerender(<ActiveJobsIndicator />);
    expect(screen.queryByTestId("active-jobs-indicator")).not.toBeInTheDocument();
  });
});
