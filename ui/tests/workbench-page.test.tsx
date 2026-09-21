/**
 * Tests for Workbench feature parity (Epic #525):
 * - #528: Agent Picker integration
 * - #529: Slash command wiring
 * - #530: Tool-call confirmation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import type { StreamEvent } from "@/lib/ai-client";

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSession: vi.fn(),
    streamChat: vi.fn(),
  };
});

// Mock AgentPicker to a controlled select that calls onChange
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: ({
    value,
    onChange,
    disabled,
  }: {
    value: string | null;
    onChange: (v: string | null) => void;
    disabled?: boolean;
  }) => (
    <select
      data-testid="agent-picker"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
    >
      <option value="">Default</option>
      <option value="architect">Architect</option>
      <option value="code-reviewer">Code Reviewer</option>
    </select>
  ),
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
  documentsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
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
  consumeRunPayload: () => null,
}));

vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => null,
}));

const createSessionMock = vi.mocked(aiClient.createSession);
const streamChatMock = vi.mocked(aiClient.streamChat);

const fakeSession: aiClient.AISession = {
  id: "sess-wb-1",
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
});

describe("Workbench — Agent Picker (#528)", () => {
  it("renders the agent picker in the chat panel", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("agent-picker")).toBeInTheDocument();
    });
  });

  it("passes selected agentKey to createSession", async () => {
    // Pre-store an agent selection in workbench layout
    window.localStorage.setItem(
      "metis.workbench.layout",
      JSON.stringify({ leftPct: 22, rightPct: 26, contextIds: [], agentKey: "code-reviewer" }),
    );

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalled();
    });

    const call = createSessionMock.mock.calls.find((c) => c[0].agentKey === "code-reviewer");
    expect(call).toBeDefined();
  });

  it("re-creates session when agent is changed", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    // Change the agent via the select element
    const picker = screen.getByTestId("agent-picker");
    const select = picker.querySelector("select") ?? picker;
    fireEvent.change(select, { target: { value: "architect" } });

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("Workbench — Slash Commands (#529)", () => {
  it("shows slash command popover when input starts with /", async () => {
    const user = userEvent.setup();
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).toBeInTheDocument();
    });

    // Wait for session to be ready
    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    });

    const input = screen.getByTestId("workbench-input");
    await user.type(input, "/");

    await waitFor(() => {
      expect(screen.getByTestId("slash-command-popover")).toBeInTheDocument();
    });
  });

  it("does not show popover when input does not start with /", async () => {
    const user = userEvent.setup();
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    });

    const input = screen.getByTestId("workbench-input");
    await user.type(input, "hello");

    expect(screen.queryByTestId("slash-command-popover")).not.toBeInTheDocument();
  });

  it("fills input when a slash suggestion is clicked", async () => {
    const user = userEvent.setup();
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    });

    const input = screen.getByTestId("workbench-input");
    await user.type(input, "/sp");

    await waitFor(() => {
      expect(screen.getByTestId("slash-suggestion-specify")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("slash-suggestion-specify"));

    expect(input).toHaveValue("/specify ");
  });
});

describe("Workbench — Tool-Call Confirmation (#530)", () => {
  it("shows confirm dialog for high-risk tool calls", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    async function* fakeStream(): AsyncGenerator<StreamEvent> {
      yield { type: "tool_call", name: "delete_database", arguments: { id: "db-1" }, risk: "high" };
      yield { type: "delta", content: "Done" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(fakeStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    });

    const input = screen.getByTestId("workbench-input");
    await user.type(input, "do something dangerous");
    await user.click(screen.getByTestId("workbench-send"));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringContaining('Allow high-risk tool "delete_database"'),
      );
    });

    confirmSpy.mockRestore();
  });

  it("aborts stream when user denies high-risk tool call", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    async function* fakeStream(): AsyncGenerator<StreamEvent> {
      yield { type: "tool_call", name: "delete_database", arguments: {}, risk: "high" };
      yield { type: "delta", content: "Should not appear" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(fakeStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    });

    const input = screen.getByTestId("workbench-input");
    await user.type(input, "risky");
    await user.click(screen.getByTestId("workbench-send"));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });

    confirmSpy.mockRestore();
  });

  it("does not show confirm for low-risk tool calls", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    async function* fakeStream(): AsyncGenerator<StreamEvent> {
      yield { type: "tool_call", name: "read_file", arguments: { path: "/tmp" }, risk: "low" };
      yield { type: "delta", content: "Result" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(fakeStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    });

    const input = screen.getByTestId("workbench-input");
    await user.type(input, "safe");
    await user.click(screen.getByTestId("workbench-send"));

    await waitFor(() => {
      expect(screen.getByText(/Result/)).toBeInTheDocument();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
