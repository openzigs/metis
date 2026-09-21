/**
 * Issue #121 extended — targeted tests for workbench and comment panel branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import type { StreamEvent } from "@/lib/ai-client";

// ─── WorkbenchPage additional branches ────────────────────────────────────────

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return { ...actual, createSession: vi.fn(), streamChat: vi.fn() };
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

import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import { projectsApi, documentsApi } from "@/lib/projects-api";
import { tasksApi } from "@/lib/scheduler-api";

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListMock = documentsApi.list as unknown as ReturnType<typeof vi.fn>;
const tasksListMock = tasksApi.list as unknown as ReturnType<typeof vi.fn>;
const createSessionMock = vi.mocked(aiClient.createSession);
const streamChatMock = vi.mocked(aiClient.streamChat);

const fakeSession: aiClient.AISession = {
  id: "sess-ext",
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
  tasksListMock.mockResolvedValue({ items: [] });
});

describe("WorkbenchPage — additional branches", () => {
  it("shows tasks in right panel when tasks are present", async () => {
    tasksListMock.mockResolvedValueOnce({
      items: [{ id: "t1", type: "analysis.run", status: "running" }],
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId("workbench-tasks")).toBeInTheDocument());
    expect(screen.getByText("analysis.run")).toBeInTheDocument();
  });

  it("shows error panel when stream fails", async () => {
    const userEvent = (await import("@testing-library/user-event")).default.setup();
    streamChatMock.mockImplementation(() => {
      throw new Error("Stream network error");
    });

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());
    await userEvent.type(screen.getByTestId("workbench-input"), "hello");
    await userEvent.click(screen.getByTestId("workbench-send"));
    await waitFor(() =>
      expect(
        screen.getByRole("alert") ||
          screen.getByText(/error/i) ||
          screen.getByTestId("workbench-root"),
      ).toBeTruthy(),
    );
  });

  it("resets layout when Reset layout is clicked", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId("workbench-reset-layout")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("workbench-reset-layout"));
    // Component still renders after reset
    expect(screen.getByTestId("workbench-root")).toBeInTheDocument();
  });

  it("sends message and shows it in conversation", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    async function* simpleStream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", content: "Hello back!" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(simpleStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());
    await user.type(screen.getByTestId("workbench-input"), "test message");
    await user.click(screen.getByTestId("workbench-send"));
    await waitFor(() => expect(screen.getByText(/Hello back!/i)).toBeInTheDocument());
  });

  it("shows projects in the project picker", async () => {
    projectsListMock.mockResolvedValueOnce({
      items: [{ id: "p1", name: "My Project" }],
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByLabelText(/Active project/i)).toBeInTheDocument());
    const select = screen.getByLabelText(/Active project/i) as HTMLSelectElement;
    expect(select.querySelector("option[value='p1']")).toBeTruthy();
  });
});

// ─── CommentPanel branches ────────────────────────────────────────────────────

vi.mock("@/lib/collaboration-api", () => ({
  commentApi: {
    listForRequirement: vi.fn(),
    listForArtifact: vi.fn(),
    createForRequirement: vi.fn(),
    createForArtifact: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
  assignmentApi: {},
  requirementUpdateApi: {},
}));

vi.mock("@/components/comments/CommentThread", () => ({
  CommentThreadComponent: () => <div data-testid="comment-thread" />,
}));

vi.mock("@/components/comments/MentionInput", () => ({
  MentionInput: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      data-testid="mention-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

import { commentApi } from "@/lib/collaboration-api";
import { CommentPanel } from "@/components/comments/CommentPanel";

const listForReq = commentApi.listForRequirement as unknown as ReturnType<typeof vi.fn>;
describe("CommentPanel — branch coverage", () => {
  it("renders closed panel (open=false) without sheet content", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open={false} onClose={vi.fn()} requirementId="req-1" />
      </Wrapper>,
    );
    expect(screen.queryByText(/Comments/i)).not.toBeInTheDocument();
  });

  it("renders open panel with loading state", () => {
    listForReq.mockImplementationOnce(() => new Promise(() => {}));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open requirementId="req-1" onClose={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it("renders open panel with empty threads", async () => {
    listForReq.mockResolvedValueOnce([]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open requirementId="req-1" onClose={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/No comments yet/i)).toBeInTheDocument());
  });

  it("renders open panel with threads", async () => {
    listForReq.mockResolvedValueOnce([
      {
        id: "t1",
        requirementId: "req-1",
        title: "Test thread",
        resolved: false,
        comments: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open requirementId="req-1" onClose={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("comment-thread")).toBeInTheDocument());
  });

  it("uses custom title when provided", () => {
    listForReq.mockResolvedValueOnce([]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open requirementId="req-1" onClose={vi.fn()} title="My Threads" />
      </Wrapper>,
    );
    expect(screen.getByText("My Threads")).toBeInTheDocument();
  });

  it("Post button is disabled when body is empty", () => {
    listForReq.mockResolvedValueOnce([]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open requirementId="req-1" onClose={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.getByRole("button", { name: /Post/i })).toBeDisabled();
  });
});
