/**
 * Tests for Workbench feature parity (Epic #525):
 * - #528: Agent Picker integration
 * - #529: Slash command wiring
 * - #142/#143: tool approvals — the Workbench answers the server gate's prompts
 *   exactly as Chat does (#530's local confirm() decided nothing and is gone)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import type { StreamEvent } from "@/lib/ai-client";
import type { AiToolEvent } from "@metis/shared";

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSession: vi.fn(),
    streamChat: vi.fn(),
    decideToolApproval: vi.fn(),
  };
});

// The session room (#142): the hook joins it and listens for `ai:tool:event`.
const socketHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
const socketEmit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({
    emit: socketEmit,
    on: (name: string, fn: (p: unknown) => void) => socketHandlers.set(name, fn),
    off: (name: string) => socketHandlers.delete(name),
  }),
}));

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
const decideMock = vi.mocked(aiClient.decideToolApproval);

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

describe("Workbench — tool approvals (#142)", () => {
  const PROMPT: AiToolEvent = {
    type: "tool_event",
    phase: "awaiting_approval",
    sessionId: "sess-wb-1",
    callId: "c1",
    name: "inspect_schema",
    risk: "medium",
    source: "metis",
    argsPreview: '{"connectionId":"db-1"}',
    approvalId: "apr_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ts: 1,
  };

  /**
   * A turn that stops at the approval prompt, as the server's does, and
   * resumes with whatever the test feeds it once the owner has answered.
   */
  function promptingStream(after: () => StreamEvent[]) {
    let release: () => void = () => undefined;
    const answered = new Promise<void>((r) => (release = r));
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { ...PROMPT, phase: "started", approvalId: undefined, expiresAt: undefined };
      yield PROMPT;
      await answered;
      for (const ev of after()) yield ev;
      yield { type: "done" };
    }
    return { stream: gen(), release: () => release() };
  }

  async function sendMessage(text: string) {
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());
    await user.type(screen.getByTestId("workbench-input"), text);
    await user.click(screen.getByTestId("workbench-send"));
  }

  it("shows the prompt; Approve sends the owner's answer and the tool's result appears", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const turn = promptingStream(() => [
      { ...PROMPT, phase: "result", approvalId: undefined, resultPreview: "3 tables" },
      // #713's post-decision summary frame must not raise a local prompt.
      { type: "tool_call", name: "inspect_schema", arguments: {}, risk: "medium" },
      { type: "delta", content: "There are 3 tables." },
    ]);
    streamChatMock.mockReturnValue(turn.stream);
    decideMock.mockImplementation(async () => {
      turn.release();
      return { approvalId: "apr_1", decision: "approve" };
    });
    render(<WorkbenchPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendMessage("what tables are there?");

    const approve = await screen.findByRole("button", { name: "Approve inspect_schema" });
    expect(screen.getByText("waiting for your approval")).toBeInTheDocument();
    expect(screen.getByText('{"connectionId":"db-1"}')).toBeInTheDocument();
    fireEvent.click(approve);

    await waitFor(() => expect(decideMock).toHaveBeenCalledWith("sess-wb-1", "apr_1", "approve"));
    expect(await screen.findByText("3 tables")).toBeInTheDocument();
    expect(await screen.findByText(/There are 3 tables\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve inspect_schema" })).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Deny sends a denial and the call shows as refused", async () => {
    const turn = promptingStream(() => [
      {
        ...PROMPT,
        phase: "error",
        approvalId: undefined,
        isError: true,
        code: "TOOL_DENIED",
      },
      { type: "delta", content: "Understood, I did not inspect it." },
    ]);
    streamChatMock.mockReturnValue(turn.stream);
    decideMock.mockImplementation(async () => {
      turn.release();
      return { approvalId: "apr_1", decision: "deny" };
    });
    render(<WorkbenchPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendMessage("inspect it");

    fireEvent.click(await screen.findByRole("button", { name: "Deny inspect_schema" }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith("sess-wb-1", "apr_1", "deny"));
    expect(await screen.findByText("Denied — the tool did not run.")).toBeInTheDocument();
  });

  it("says so when the approval is no longer pending", async () => {
    const turn = promptingStream(() => []);
    streamChatMock.mockReturnValue(turn.stream);
    decideMock.mockRejectedValue(new Error("404"));
    render(<WorkbenchPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendMessage("inspect it");
    fireEvent.click(await screen.findByRole("button", { name: "Approve inspect_schema" }));
    expect(await screen.findByText(/no longer pending/)).toBeInTheDocument();
    turn.release();
  });

  it("joins the session room: a prompt that arrives only there can be answered too", async () => {
    decideMock.mockResolvedValue({ approvalId: "apr_1", decision: "approve" });
    render(<WorkbenchPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await waitFor(() =>
      expect(socketEmit).toHaveBeenCalledWith("subscribe:session", { sessionId: "sess-wb-1" }),
    );
    await waitFor(() => expect(socketHandlers.has("ai:tool:event")).toBe(true));
    act(() => socketHandlers.get("ai:tool:event")!(PROMPT));
    fireEvent.click(await screen.findByRole("button", { name: "Approve inspect_schema" }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith("sess-wb-1", "apr_1", "approve"));
    // Another session's event never lands here.
    act(() =>
      socketHandlers.get("ai:tool:event")!({ ...PROMPT, sessionId: "sess-other", name: "other" }),
    );
    expect(screen.queryByText("other")).toBeNull();
  });
});
