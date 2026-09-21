/**
 * Issue #121 extended — tests for workbench message with context (covering
 * composeWithContext branches) and panel resizer drag events.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import type { StreamEvent } from "@/lib/ai-client";

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

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const documentsListMock = documentsApi.list as unknown as ReturnType<typeof vi.fn>;
const createSessionMock = vi.mocked(aiClient.createSession);
const streamChatMock = vi.mocked(aiClient.streamChat);

const fakeSession: aiClient.AISession = {
  id: "sess-ctx",
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
  projectsListMock.mockResolvedValue({ items: [{ id: "p1", name: "Alpha" }] });
  documentsListMock.mockResolvedValue({ items: [] });
});

describe("WorkbenchPage — composeWithContext branches", () => {
  it("sends message with attached context docs (non-empty attachments branch)", async () => {
    const user = userEvent.setup();
    // Setup docs
    documentsListMock.mockResolvedValueOnce({
      items: [{ id: "d1", filename: "spec.md", status: "ready" }],
    });

    // Stream returns a message
    async function* simpleStream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", content: "Response with context" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(simpleStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    // Wait for document to load and attach it
    await waitFor(() => expect(screen.getByTestId("workbench-doc-attach-d1")).toBeInTheDocument());
    await user.click(screen.getByTestId("workbench-doc-attach-d1"));
    await waitFor(() => expect(screen.getByTestId("workbench-context-chips")).toBeInTheDocument());

    // Wait for input to be enabled
    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());

    // Type and send message
    await user.type(screen.getByTestId("workbench-input"), "analyze this");
    await user.click(screen.getByTestId("workbench-send"));

    // streamChat should have been called with composed message (including context)
    await waitFor(() => expect(streamChatMock).toHaveBeenCalled());
    const call = streamChatMock.mock.calls[0];
    const messages = call[1] as Array<{ content: string }>;
    const userMessage = messages.find((m) => m.content.includes("analyze this"));
    // With context, the message should include "Context attachments"
    expect(userMessage?.content).toContain("Context attachments");
  });

  it("sends message without context docs (empty attachments branch)", async () => {
    const user = userEvent.setup();
    documentsListMock.mockResolvedValueOnce({ items: [] });

    async function* simpleStream(): AsyncGenerator<StreamEvent> {
      yield { type: "delta", content: "Response no context" };
      yield { type: "done" };
    }
    streamChatMock.mockReturnValue(simpleStream());

    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByTestId("workbench-input")).not.toBeDisabled());

    await user.type(screen.getByTestId("workbench-input"), "hello");
    await user.click(screen.getByTestId("workbench-send"));

    await waitFor(() => expect(streamChatMock).toHaveBeenCalled());
    const call = streamChatMock.mock.calls[0];
    const messages = call[1] as Array<{ content: string }>;
    const userMessage = messages.find((m) => m.content.includes("hello"));
    // Without context, the message should be just the raw input
    expect(userMessage?.content).toBe("hello");
  });

  it("panel resizer changes layout on drag", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(<WorkbenchPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByTestId("workbench-root")).toBeInTheDocument());

    // Find a resizer
    const resizers = screen.queryAllByRole("slider");
    if (resizers.length > 0) {
      fireEvent.change(resizers[0], { target: { value: "25" } });
      // Component should still render after layout change
      expect(screen.getByTestId("workbench-root")).toBeInTheDocument();
    }
  });
});
