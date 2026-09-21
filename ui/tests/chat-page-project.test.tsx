/**
 * Bug #236 — Verifies that the Chat page threads `projectId` from
 * the URL query string into the session creation API call.
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
    scope: { mode: "all", projectIds: [] },
    setScope: () => {},
    // #1367 — the page waits for this before creating a session.
    hydrated: true,
  }),
}));

vi.mock("@/components/chat/provenance-content", () => ({
  ProvenanceContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

const createSessionMock = vi.mocked(aiClient.createSessionWithScope);
const useSearchParamsMock = vi.mocked(useSearchParams);

const fakeSession: aiClient.AISession = {
  id: "sess-1",
  title: "New Chat",
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
  createSessionMock.mockResolvedValue({ session: fakeSession, scope: null });
});

describe("<ChatPage /> — projectId threading (#236)", () => {
  it("creates a session WITHOUT projectId when no query param is set", async () => {
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    const Wrapper = makeWrapper({ withAuth: false });
    render(<ChatPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    const arg = createSessionMock.mock.calls[0]![0];
    expect(arg).not.toHaveProperty("projectId");
    expect(arg.title).toBe("New Chat");
  });

  it("creates a session WITH projectId when the query param is present", async () => {
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams("projectId=proj-42") as ReturnType<typeof useSearchParams>,
    );
    const Wrapper = makeWrapper({ withAuth: false });
    render(<ChatPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    const arg = createSessionMock.mock.calls[0]![0];
    expect(arg.projectId).toBe("proj-42");
    expect(arg.title).toBe("New Chat");
  });

  it("shows provider and model after session is established", async () => {
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams("projectId=proj-42") as ReturnType<typeof useSearchParams>,
    );
    const Wrapper = makeWrapper({ withAuth: false });
    render(<ChatPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/bedrock-gateway/)).toBeInTheDocument();
    });
  });
});
