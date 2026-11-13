/**
 * Issue #607 — Chat page forwards a multi-project scope selection to the
 * session API and visibly surfaces the server's scope-degradation metadata
 * (a 2+ project selection yields an unscoped session — the user must be
 * told, not silently downgraded).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { makeWrapper } from "./test-utils";
import { acceptedTurn, sendChatMessage } from "./chat-send";
import ChatPage from "@/app/(authed)/chat/page";
import * as aiClient from "@/lib/ai-client";

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSessionWithScope: vi.fn(),
    streamChat: vi.fn(),
  };
});

vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: () => <div data-testid="agent-picker" />,
  loadStoredAgentKey: () => null,
  storeAgentKey: () => undefined,
}));

// #2350 — the history list reads its own query; not under test here.
vi.mock("@/components/chat/chat-history", () => ({ ChatHistory: () => null }));
vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => null,
}));

// #2238 — the scope the selector holds; a test may switch it to a workspace.
const scopeState = vi.hoisted(() => ({
  scope: { mode: "selected", projectIds: ["proj-1", "proj-2"] } as {
    mode: "all" | "selected" | "workspace";
    projectIds: string[];
    workspaceId?: string;
  },
}));

vi.mock("@/components/chat/project-scope-selector", () => ({
  ProjectScopeSelector: () => <div data-testid="project-scope-selector" />,
  loadStoredScope: () => null,
  useProjectScope: () => ({
    scope: scopeState.scope,
    setScope: () => {},
    // #1367 — the page waits for this before creating a session.
    hydrated: true,
  }),
}));

const createSessionWithScopeMock = vi.mocked(aiClient.createSessionWithScope);
const useSearchParamsMock = vi.mocked(useSearchParams);

const fakeSession: aiClient.AISession = {
  id: "sess-1",
  title: "New Chat",
  provider: "offline-stub",
  model: "stub-model",
  policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
  status: "active",
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeState.scope = { mode: "selected", projectIds: ["proj-1", "proj-2"] };
  useSearchParamsMock.mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>);
  vi.mocked(aiClient.streamChat).mockImplementation(acceptedTurn as typeof aiClient.streamChat);
});

describe("<ChatPage /> — multi-project scope degradation (#607)", () => {
  it("forwards ALL selected projectIds and surfaces the degradation notice", async () => {
    createSessionWithScopeMock.mockResolvedValue({
      session: fakeSession,
      scope: {
        requestedProjectIds: ["proj-1", "proj-2"],
        appliedProjectId: null,
        degraded: true,
        reason: "multi-project-unsupported",
      },
    });
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendChatMessage("which tables?");

    await waitFor(() => {
      expect(createSessionWithScopeMock).toHaveBeenCalledTimes(1);
    });
    const arg = createSessionWithScopeMock.mock.calls[0]![0];
    expect(arg.projectIds).toEqual(["proj-1", "proj-2"]);

    const notice = await screen.findByTestId("scope-degradation-notice");
    expect(notice).toHaveTextContent(/single project/i);
    expect(notice).toHaveTextContent(/unscoped/i);
    // #1368/#1139 — the first send created the session but did NOT run the
    // turn: the user is told before an unscoped answer, and keeps the text.
    expect(aiClient.streamChat).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message")).toHaveValue("which tables?");
    expect(screen.getByLabelText("Message")).toBeDisabled();
  });

  it("shows no notice when the scope was applied as requested", async () => {
    createSessionWithScopeMock.mockResolvedValue({
      session: { ...fakeSession, projectId: "proj-1" },
      scope: {
        requestedProjectIds: ["proj-1"],
        appliedProjectId: "proj-1",
        degraded: false,
      },
    });
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendChatMessage();

    await waitFor(() => {
      expect(createSessionWithScopeMock).toHaveBeenCalledTimes(1);
    });
    // Session established (provider · model shown), no degradation banner.
    expect(await screen.findByText(/offline-stub/)).toBeInTheDocument();
    expect(screen.queryByTestId("scope-degradation-notice")).not.toBeInTheDocument();
  });

  it("shows no notice against an older server that returns no scope metadata", async () => {
    createSessionWithScopeMock.mockResolvedValue({ session: fakeSession, scope: null });
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendChatMessage();

    expect(await screen.findByText(/offline-stub/)).toBeInTheDocument();
    expect(screen.queryByTestId("scope-degradation-notice")).not.toBeInTheDocument();
  });
});

describe("<ChatPage /> — multi-product chat (#2238)", () => {
  it("sends the turn of a multi-product session, which is grounded, not unscoped", async () => {
    createSessionWithScopeMock.mockResolvedValue({
      session: { ...fakeSession, scopeProjectIds: ["proj-1", "proj-2"] },
      scope: {
        requestedProjectIds: ["proj-1", "proj-2"],
        appliedProjectId: null,
        appliedProjectIds: ["proj-1", "proj-2"],
        appliedWorkspaceId: null,
        degraded: false,
      },
    });
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    // Before the first send: the scope will search, so no "not grounded" notice.
    expect(screen.queryByTestId("chat-ungrounded-notice")).not.toBeInTheDocument();
    await sendChatMessage("what changes in A and B?");

    await waitFor(() => expect(aiClient.streamChat).toHaveBeenCalledTimes(1));
    expect(createSessionWithScopeMock.mock.calls[0]![0].projectIds).toEqual(["proj-1", "proj-2"]);
    expect(screen.queryByTestId("scope-degradation-notice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-ungrounded-notice")).not.toBeInTheDocument();
  });

  it("creates a workspace-scoped session from a workspace scope", async () => {
    scopeState.scope = { mode: "workspace", projectIds: [], workspaceId: "w-1" };
    createSessionWithScopeMock.mockResolvedValue({
      session: { ...fakeSession, scopeWorkspaceId: "w-1" },
      scope: {
        requestedProjectIds: [],
        appliedProjectId: null,
        appliedProjectIds: [],
        appliedWorkspaceId: "w-1",
        degraded: false,
      },
    });
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await sendChatMessage("q");
    await waitFor(() => expect(aiClient.streamChat).toHaveBeenCalledTimes(1));
    const arg = createSessionWithScopeMock.mock.calls[0]![0];
    expect(arg.workspaceId).toBe("w-1");
    expect(arg.projectIds).toBeUndefined();
    expect(screen.queryByTestId("chat-ungrounded-notice")).not.toBeInTheDocument();
  });

  it("still warns before the first send when the scope is 'All projects'", async () => {
    scopeState.scope = { mode: "all", projectIds: [] };
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(await screen.findByTestId("chat-ungrounded-notice")).toBeInTheDocument();
  });
});
