/**
 * Phase 12 — Dashboard page widget tests.
 *
 * Covers loading, empty, and populated states for each of the four widgets
 * (Projects, Tasks, Scheduler, Recent) plus the polled refetch behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import DashboardPage from "@/app/(authed)/dashboard/page";
import { projectsApi } from "@/lib/projects-api";
import { tasksApi, schedulerApi } from "@/lib/scheduler-api";
import { recentTracker } from "@/lib/recent-tracker";

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn() },
}));
vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn() },
  schedulerApi: { list: vi.fn() },
}));

const projectsListMock = vi.mocked(projectsApi.list);
const tasksListMock = vi.mocked(tasksApi.list);
const schedulerListMock = vi.mocked(schedulerApi.list);

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DashboardPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  // Defaults to empty so each test can override what it needs.
  projectsListMock.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
  tasksListMock.mockResolvedValue({ items: [], total: 0 });
  schedulerListMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("<DashboardPage />", () => {
  it("renders the four widgets", async () => {
    renderPage();
    expect(screen.getByTestId("widget-projects")).toBeInTheDocument();
    expect(screen.getByTestId("widget-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("widget-scheduler")).toBeInTheDocument();
    expect(screen.getByTestId("widget-recent")).toBeInTheDocument();
  });

  it("shows loading skeletons before queries resolve", () => {
    // Hold the queries open by returning never-resolving promises.
    projectsListMock.mockImplementation(() => new Promise(() => {}));
    tasksListMock.mockImplementation(() => new Promise(() => {}));
    schedulerListMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    // Three async widgets each render their skeleton block with role="status".
    const skeletons = screen.getAllByRole("status");
    // Skeletons + the empty Recent widget which is not loading -> at least 3.
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the empty state and CTA for each widget when nothing is returned", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No projects yet")).toBeInTheDocument();
      expect(screen.getByText("Nothing running")).toBeInTheDocument();
      expect(screen.getByText("No scheduled jobs")).toBeInTheDocument();
      expect(screen.getByText("No recent items")).toBeInTheDocument();
    });
    expect(screen.getByTestId("widget-projects-empty-cta")).toHaveAttribute("href", "/projects");
    expect(screen.getByTestId("widget-tasks-empty-cta")).toHaveAttribute("href", "/tasks");
    expect(screen.getByTestId("widget-scheduler-empty-cta")).toHaveAttribute("href", "/scheduler");
    expect(screen.getByTestId("widget-recent-empty-cta")).toHaveAttribute("href", "/workbench");
  });

  it("renders populated lists for each widget", async () => {
    projectsListMock.mockResolvedValue({
      items: [
        {
          id: "p-1",
          name: "Migration Alpha",
          slug: "alpha",
          status: "active",
          createdById: "u-1",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
        },
      ],
      total: 1,
      limit: 5,
      offset: 0,
    });
    tasksListMock.mockResolvedValue({
      items: [
        {
          id: "t-1",
          scheduledJobId: null,
          projectId: null,
          type: "analysis.run",
          trigger: "manual",
          status: "running",
          priority: 0,
          payload: "{}",
          result: null,
          errorMessage: null,
          progress: null,
          attempts: 0,
          maxAttempts: 1,
          scheduledFor: null,
          startedAt: null,
          completedAt: null,
          createdById: null,
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
        },
      ],
      total: 1,
    });
    schedulerListMock.mockResolvedValue([
      {
        id: "j-1",
        key: "nightly",
        name: "Nightly Sweep",
        cron: "0 0 * * *",
        taskType: "analysis.run",
        payload: "{}",
        projectId: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        maxAttempts: 1,
        createdById: null,
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        deletedAt: null,
      },
    ]);
    recentTracker.touch({
      kind: "session",
      id: "s-1",
      label: "Recent Chat",
      href: "/workbench/sessions/s-1",
      touchedAt: "2026-04-25T00:00:00Z",
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Migration Alpha")).toBeInTheDocument());
    expect(screen.getByText("analysis.run")).toBeInTheDocument();
    expect(screen.getByText("Nightly Sweep")).toBeInTheDocument();
    expect(screen.getByText("Recent Chat")).toBeInTheDocument();
  });

  it("polls the project widget on the configured interval", async () => {
    renderPage();
    await waitFor(() => expect(projectsListMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(projectsListMock.mock.calls.length).toBeGreaterThan(1));
  });
});

// Issue #58 — screen-reader audit. The dashboard must expose a single top-level
// heading, a labelled widgets region, and a heading per widget so SR users can
// navigate the grid by landmark/heading rather than reading it top-to-bottom.
describe("DashboardPage — screen-reader affordances (#58)", () => {
  it("exposes an h1, a labelled widgets region, and a heading per widget", () => {
    renderPage();
    const h1 = screen.getByRole("heading", { level: 1, name: "Dashboard" });
    expect(h1).toBeInTheDocument();
    // The widgets grid is a labelled region so it is announced as a group.
    expect(screen.getByRole("region", { name: "Dashboard widgets" })).toBeInTheDocument();
    for (const name of [
      "Projects",
      "Active analyses & tasks",
      "Active runs",
      "Scheduled jobs",
      "Recent activity",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });
});
