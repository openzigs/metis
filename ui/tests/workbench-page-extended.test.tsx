/**
 * Issue #121 — extended tests for WorkbenchPage to improve branch coverage.
 *
 * Supplements workbench-page.test.tsx. Tests the branches not covered there:
 * document listing, context attachment/detachment, recent analyses/tasks,
 * project loading, template seeding, error in session creation, and layout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSession: vi.fn(),
    streamChat: vi.fn(),
  };
});

vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (v: string | null) => void;
  }) => (
    <select
      data-testid="agent-picker"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Default</option>
      <option value="architect">Architect</option>
    </select>
  ),
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn() },
  documentsApi: { list: vi.fn() },
}));

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { listForProject: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/recent-tracker", () => ({
  recentTracker: { touch: vi.fn(), list: () => [] },
}));

vi.mock("@/lib/templates", () => ({
  consumeRunPayload: vi.fn().mockReturnValue(null),
}));

vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => null,
}));

import { projectsApi, documentsApi } from "@/lib/projects-api";
import { analysisApi } from "@/lib/analysis-api";
import { tasksApi } from "@/lib/scheduler-api";
import { consumeRunPayload } from "@/lib/templates";

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListMock = documentsApi.list as unknown as ReturnType<typeof vi.fn>;
const analysisListMock = analysisApi.listForProject as unknown as ReturnType<typeof vi.fn>;
const tasksListMock = tasksApi.list as unknown as ReturnType<typeof vi.fn>;
const consumeRunPayloadMock = consumeRunPayload as unknown as ReturnType<typeof vi.fn>;
const createSessionMock = vi.mocked(aiClient.createSession);

const fakeSession: aiClient.AISession = {
  id: "sess-wb-ext",
  title: "Workbench",
  provider: "bedrock-gateway",
  model: "anthropic.claude-sonnet-4-5",
  policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
  status: "active",
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  createSessionMock.mockResolvedValue(fakeSession);
  projectsListMock.mockResolvedValue({ items: [] });
  documentsListMock.mockResolvedValue({ items: [] });
  analysisListMock.mockResolvedValue({ items: [] });
  tasksListMock.mockResolvedValue({ items: [] });
  consumeRunPayloadMock.mockReturnValue(null);
});

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(<WorkbenchPage />, { wrapper: Wrapper });
}

describe("WorkbenchPage — empty initial state", () => {
  it("shows placeholder message when no messages", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/answers are grounded in its code/i)).toBeInTheDocument(),
    );
  });

  it("shows no analyses message when project loaded but no analyses", async () => {
    projectsListMock.mockResolvedValueOnce({ items: [{ id: "p1", name: "Project" }] });
    analysisListMock.mockResolvedValueOnce({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No analyses yet/i)).toBeInTheDocument());
  });

  it("shows 'Choose a project' when no active project", async () => {
    projectsListMock.mockResolvedValueOnce({ items: [] });
    renderPage();
    // Both the left panel EmptyState and the analyses section render
    // "Choose a project" when activeProjectId is null
    await waitFor(() => expect(screen.getAllByText(/Choose a project/i).length).toBeGreaterThan(0));
  });
});

describe("WorkbenchPage — document tree and context", () => {
  it("renders document list after project loads", async () => {
    projectsListMock.mockResolvedValueOnce({ items: [{ id: "p1", name: "Alpha" }] });
    documentsListMock.mockResolvedValueOnce({
      items: [{ id: "d1", filename: "spec.md", status: "ready" }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("spec.md")).toBeInTheDocument());
  });

  it("attaches document to context when clicked and shows chip", async () => {
    const user = userEvent.setup();
    projectsListMock.mockResolvedValueOnce({ items: [{ id: "p1", name: "Alpha" }] });
    documentsListMock.mockResolvedValueOnce({
      items: [{ id: "d1", filename: "spec.md", status: "ready" }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("workbench-doc-d1")).toBeInTheDocument());
    // Click the Attach button (not the filename span)
    await user.click(screen.getByTestId("workbench-doc-attach-d1"));
    await waitFor(() => expect(screen.getByTestId("workbench-context-chips")).toBeInTheDocument());
    expect(screen.getByLabelText(/Remove spec\.md from context/i)).toBeInTheDocument();
  });

  it("detaches document from context when chip is clicked", async () => {
    const user = userEvent.setup();
    projectsListMock.mockResolvedValueOnce({ items: [{ id: "p1", name: "Alpha" }] });
    documentsListMock.mockResolvedValueOnce({
      items: [{ id: "d1", filename: "spec.md", status: "ready" }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("workbench-doc-attach-d1")).toBeInTheDocument());
    await user.click(screen.getByTestId("workbench-doc-attach-d1"));
    await waitFor(() => expect(screen.getByTestId("workbench-context-chips")).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Remove spec\.md from context/i));
    await waitFor(() =>
      expect(screen.queryByTestId("workbench-context-chips")).not.toBeInTheDocument(),
    );
  });

  it("clears all context when 'clear all' is clicked", async () => {
    const user = userEvent.setup();
    projectsListMock.mockResolvedValueOnce({ items: [{ id: "p1", name: "Alpha" }] });
    documentsListMock.mockResolvedValueOnce({
      items: [
        { id: "d1", filename: "spec.md", status: "ready" },
        { id: "d2", filename: "arch.md", status: "ready" },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("workbench-doc-attach-d1")).toBeInTheDocument());
    await user.click(screen.getByTestId("workbench-doc-attach-d1"));
    await user.click(screen.getByTestId("workbench-doc-attach-d2"));
    await waitFor(() => expect(screen.getByTestId("workbench-context-chips")).toBeInTheDocument());
    await user.click(screen.getByText(/clear all/i));
    await waitFor(() =>
      expect(screen.queryByTestId("workbench-context-chips")).not.toBeInTheDocument(),
    );
  });
});

describe("WorkbenchPage — recent analyses and tasks", () => {
  it("renders analysis items in the right panel", async () => {
    projectsListMock.mockResolvedValueOnce({ items: [{ id: "p1", name: "Alpha" }] });
    analysisListMock.mockResolvedValueOnce({
      items: [
        {
          id: "a1",
          projectId: "p1",
          status: "completed",
          startedAt: new Date("2026-01-01T10:00:00Z").toISOString(),
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("workbench-analyses")).toBeInTheDocument());
  });

  it("renders task items in the right panel", async () => {
    tasksListMock.mockResolvedValueOnce({
      items: [{ id: "t1", type: "analysis.run", status: "completed" }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("workbench-tasks")).toBeInTheDocument());
    expect(screen.getByText("analysis.run")).toBeInTheDocument();
  });
});

describe("WorkbenchPage — template seeding", () => {
  it("pre-fills the input from a run payload", async () => {
    consumeRunPayloadMock.mockReturnValueOnce({ prompt: "Analyze this requirement" });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("workbench-input")).toHaveValue("Analyze this requirement"),
    );
  });
});

describe("WorkbenchPage — error state", () => {
  it("shows error when session creation fails", async () => {
    createSessionMock.mockRejectedValueOnce(new Error("Session creation failed"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Session creation failed/i)).toBeInTheDocument());
  });
});
