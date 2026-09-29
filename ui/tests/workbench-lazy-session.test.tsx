/**
 * Issue #361 — opening /workbench must not create a chat session.
 *
 * Every page load used to POST /api/ai/sessions up to three times (once for the
 * initial render, once when the project list resolved, and again under React
 * StrictMode's effect double-invoke), leaving empty "Workbench" sessions in
 * Recent and the dashboard's "Recent activity". The session is now created on
 * the first send, and recorded as recent only once a turn has happened.
 */
import { StrictMode, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import WorkbenchPage from "@/app/(authed)/workbench/page";
import * as aiClient from "@/lib/ai-client";
import type { StreamEvent } from "@/lib/ai-client";

vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));

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
      <option value="architect">Architect</option>
    </select>
  ),
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn() },
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
vi.mock("@/lib/templates", () => ({ consumeRunPayload: () => null }));
vi.mock("@/components/chat/loaded-skills-panel", () => ({ LoadedSkillsPanel: () => null }));

import { projectsApi } from "@/lib/projects-api";
import { recentTracker } from "@/lib/recent-tracker";

const projectsListMock = projectsApi.list as unknown as ReturnType<typeof vi.fn>;
const createSessionMock = vi.mocked(aiClient.createSession);
const streamChatMock = vi.mocked(aiClient.streamChat);
const touchMock = vi.mocked(recentTracker.touch);

function session(id: string, projectId: string | null = "p1"): aiClient.AISession {
  return {
    id,
    title: "Workbench",
    provider: "bedrock-gateway",
    model: "anthropic.claude-sonnet-4-5",
    policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
    status: "active",
    projectId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function* reply(text: string): AsyncGenerator<StreamEvent> {
  yield { type: "delta", content: text };
  yield { type: "done" };
}

/** The page as a browser loads it in dev: StrictMode double-invokes effects. */
function renderStrict() {
  const Inner = makeWrapper({ withAuth: false });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <Inner>{children}</Inner>
      </StrictMode>
    );
  }
  return render(<WorkbenchPage />, { wrapper: Wrapper });
}

/** Wait until the project list has resolved and the page has settled on p1. */
async function waitForProject() {
  await waitFor(() => expect(screen.getByTestId("workbench-project-picker")).toHaveValue("p1"));
}

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByTestId("workbench-input"), text);
  await user.click(screen.getByTestId("workbench-send"));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  projectsListMock.mockResolvedValue({
    items: [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
  });
  createSessionMock.mockResolvedValue(session("sess-1"));
  streamChatMock.mockImplementation(() => reply("hello back"));
});

describe("Workbench — no session until the first message (#361)", () => {
  it("a page load issues zero session-create requests, even under StrictMode", async () => {
    renderStrict();
    await waitForProject();
    // The input is usable without a session: the send creates one.
    expect(screen.getByTestId("workbench-input")).not.toBeDisabled();
    // Let any trailing effects/promises flush before asserting the negative.
    await new Promise((r) => setTimeout(r, 50));
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(touchMock).not.toHaveBeenCalled();
  });

  it("switching project and agent before sending still creates nothing", async () => {
    renderStrict();
    await waitForProject();
    fireEvent.change(screen.getByTestId("workbench-project-picker"), { target: { value: "p2" } });
    fireEvent.change(screen.getByTestId("agent-picker"), { target: { value: "architect" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("the first send creates exactly one session, scoped to the project and agent, and streams to it", async () => {
    renderStrict();
    await waitForProject();
    fireEvent.change(screen.getByTestId("agent-picker"), { target: { value: "architect" } });
    await send("what is this?");

    expect(await screen.findByText(/hello back/)).toBeInTheDocument();
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock.mock.calls[0]![0]).toMatchObject({
      title: "Workbench",
      projectId: "p1",
      agentKey: "architect",
    });
    expect(streamChatMock).toHaveBeenCalledWith("sess-1", "what is this?", expect.anything());
    expect(screen.getByText(/bedrock-gateway · anthropic\.claude-sonnet-4-5/)).toBeInTheDocument();
  });

  it("a second send reuses the session", async () => {
    renderStrict();
    await waitForProject();
    await send("one");
    await screen.findByText(/hello back/);
    await waitFor(() => expect(screen.getByTestId("workbench-send")).toHaveTextContent("Send"));
    await send("two");
    await waitFor(() => expect(streamChatMock).toHaveBeenCalledTimes(2));
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(streamChatMock.mock.calls[1]![0]).toBe("sess-1");
  });

  it("records the session in Recent only after a turn, with a link Chat can resume", async () => {
    renderStrict();
    await waitForProject();
    await send("hi");
    await screen.findByText(/hello back/);
    await waitFor(() => expect(touchMock).toHaveBeenCalledTimes(1));
    expect(touchMock).toHaveBeenCalledWith({
      kind: "session",
      id: "sess-1",
      label: "Workbench",
      // The Chat page resumes from `sessionId`, not `session`.
      href: "/chat?sessionId=sess-1",
      projectId: "p1",
    });
  });

  it("changing project after a turn starts a fresh session on the next send", async () => {
    createSessionMock
      .mockResolvedValueOnce(session("sess-1"))
      .mockResolvedValueOnce(session("sess-2", "p2"));
    renderStrict();
    await waitForProject();
    await send("first");
    await screen.findByText(/hello back/);
    await waitFor(() => expect(screen.getByTestId("workbench-send")).toHaveTextContent("Send"));

    fireEvent.change(screen.getByTestId("workbench-project-picker"), { target: { value: "p2" } });
    await waitFor(() => expect(screen.queryByText(/hello back/)).toBeNull());
    expect(createSessionMock).toHaveBeenCalledTimes(1);

    await send("second");
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(2));
    expect(createSessionMock.mock.calls[1]![0]).toMatchObject({ projectId: "p2" });
    await waitFor(() =>
      expect(streamChatMock).toHaveBeenLastCalledWith("sess-2", "second", expect.anything()),
    );
  });

  it("a failed create shows the error and keeps the typed message", async () => {
    createSessionMock.mockRejectedValueOnce(new Error("Session creation failed"));
    renderStrict();
    await waitForProject();
    await send("keep me");
    expect(await screen.findByText(/Session creation failed/)).toBeInTheDocument();
    expect(screen.getByTestId("workbench-input")).toHaveValue("keep me");
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("workbench-message")).toHaveLength(0);
  });

  it("a session that resolves after the project changed is discarded, not streamed to", async () => {
    let resolveCreate: (s: aiClient.AISession) => void = () => undefined;
    createSessionMock.mockImplementationOnce(
      () => new Promise<aiClient.AISession>((r) => (resolveCreate = r)),
    );
    renderStrict();
    await waitForProject();
    await send("slow");
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("workbench-project-picker"), { target: { value: "p2" } });
    resolveCreate(session("sess-stale"));
    await new Promise((r) => setTimeout(r, 50));

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(touchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/bedrock-gateway ·/)).toBeNull();
  });
});
