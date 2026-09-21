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

vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => null,
}));

vi.mock("@/components/chat/project-scope-selector", () => ({
  ProjectScopeSelector: () => <div data-testid="project-scope-selector" />,
  useProjectScope: () => ({
    scope: { mode: "selected", projectIds: ["proj-1", "proj-2"] },
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
  useSearchParamsMock.mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>);
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

    await waitFor(() => {
      expect(createSessionWithScopeMock).toHaveBeenCalledTimes(1);
    });
    const arg = createSessionWithScopeMock.mock.calls[0]![0];
    expect(arg.projectIds).toEqual(["proj-1", "proj-2"]);

    const notice = await screen.findByTestId("scope-degradation-notice");
    expect(notice).toHaveTextContent(/single project/i);
    expect(notice).toHaveTextContent(/unscoped/i);
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

    expect(await screen.findByText(/offline-stub/)).toBeInTheDocument();
    expect(screen.queryByTestId("scope-degradation-notice")).not.toBeInTheDocument();
  });
});
