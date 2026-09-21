/**
 * Epic #156 — UI tests for triggers settings + dashboard active-runs widget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import TriggersSettingsPage from "@/app/(authed)/settings/triggers/page";
import DashboardPage from "@/app/(authed)/dashboard/page";
import { asyncApi } from "@/lib/async-platform-api";

vi.mock("@/lib/async-platform-api", () => ({
  asyncApi: {
    listTriggers: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
    listBackgroundRuns: vi.fn(),
    cancelBackgroundRun: vi.fn(),
    pauseBackgroundRun: vi.fn(),
    resumeBackgroundRun: vi.fn(),
  },
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    // `/search/projects` backs the triggers project picker.
    apiFetch: vi.fn(async () => [{ id: "p1", name: "Project One" }]),
  };
});

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn(async () => ({ items: [] })) },
}));
vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn(async () => ({ items: [] })) },
  schedulerApi: { list: vi.fn(async () => []) },
}));

const api = vi.mocked(asyncApi);

beforeEach(() => {
  vi.clearAllMocks();
});

/** Select project "p1" via the searchable picker. */
async function pickProjectP1() {
  const trigger = await screen.findByTestId("tg-project-id");
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId("tg-project-option-p1"));
}

describe("TriggersSettingsPage (#147)", () => {
  it("hides the form until a project id is supplied", () => {
    render(<TriggersSettingsPage />, { wrapper: makeWrapper() });
    expect(screen.queryByTestId("tg-save")).not.toBeInTheDocument();
  });

  it("renders the trigger list once a project id is supplied", async () => {
    api.listTriggers.mockResolvedValue({
      items: [
        {
          id: "t1",
          projectId: "p1",
          name: "GH Issues",
          source: "github",
          config: { repo: "acme/app", event: "issues.opened" },
          enabled: true,
          lastFiredAt: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    render(<TriggersSettingsPage />, { wrapper: makeWrapper() });
    await pickProjectP1();
    await waitFor(() => expect(screen.getByTestId("tg-row-t1")).toBeInTheDocument());
    expect(screen.getByText(/repo=acme\/app/)).toBeInTheDocument();
  });

  it("submits a new trigger with parsed config JSON", async () => {
    api.listTriggers.mockResolvedValue({ items: [] });
    api.createTrigger.mockResolvedValue({
      id: "t2",
      projectId: "p1",
      name: "Webhook",
      source: "webhook",
      config: {},
      enabled: true,
      lastFiredAt: null,
      createdAt: "",
      updatedAt: "",
    });
    render(<TriggersSettingsPage />, { wrapper: makeWrapper() });
    await pickProjectP1();
    fireEvent.change(await screen.findByTestId("tg-name"), {
      target: { value: "Webhook" },
    });
    fireEvent.change(screen.getByTestId("tg-secret"), { target: { value: "shh" } });
    fireEvent.click(screen.getByTestId("tg-save"));
    await waitFor(() => expect(api.createTrigger).toHaveBeenCalled());
    expect(api.createTrigger).toHaveBeenCalledWith("p1", {
      name: "Webhook",
      source: "webhook",
      config: { secret: "shh" },
    });
  });
});

describe("DashboardPage active runs widget (#146)", () => {
  it("renders queued/running rows with action buttons", async () => {
    api.listBackgroundRuns.mockResolvedValue({
      items: [
        {
          id: "r1",
          projectId: "p1",
          sessionId: null,
          kind: "analysis",
          status: "running",
          priority: 0,
          runGroupId: null,
          startedAt: null,
          completedAt: null,
          error: null,
          result: null,
          score: null,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "r2",
          projectId: "p1",
          sessionId: null,
          kind: "chat",
          status: "paused",
          priority: 0,
          runGroupId: null,
          startedAt: null,
          completedAt: null,
          error: null,
          result: null,
          score: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    render(<DashboardPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("bg-run-r1")).toBeInTheDocument());
    expect(screen.getByTestId("bg-run-cancel-r1")).toBeInTheDocument();
    expect(screen.getByTestId("bg-run-pause-r1")).toBeInTheDocument();
    expect(screen.getByTestId("bg-run-resume-r2")).toBeInTheDocument();
  });

  it("calls cancel/pause/resume APIs on button click", async () => {
    api.listBackgroundRuns.mockResolvedValue({
      items: [
        {
          id: "r1",
          projectId: "p1",
          sessionId: null,
          kind: "analysis",
          status: "running",
          priority: 0,
          runGroupId: null,
          startedAt: null,
          completedAt: null,
          error: null,
          result: null,
          score: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    api.cancelBackgroundRun.mockResolvedValue({ ok: true });
    api.pauseBackgroundRun.mockResolvedValue({ ok: true });
    render(<DashboardPage />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByTestId("bg-run-cancel-r1"));
    await waitFor(() => expect(api.cancelBackgroundRun).toHaveBeenCalledWith("r1"));
    fireEvent.click(screen.getByTestId("bg-run-pause-r1"));
    await waitFor(() => expect(api.pauseBackgroundRun).toHaveBeenCalledWith("r1"));
  });
});
