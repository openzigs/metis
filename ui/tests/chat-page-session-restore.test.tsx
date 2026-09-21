/**
 * #1367 — a reload of bare `/chat` must restore the last conversation.
 *
 * The original fix resumed only on the effect's FIRST run. But `agentKey` and
 * the project scope both arrive from localStorage one tick after mount, so that
 * first run happened with DEFAULT values and burned the single allowed resume;
 * the real run then created a fresh session and overwrote the stored id. A
 * reload therefore still lost the thread, and three sessions were minted per
 * page load.
 *
 * These tests pin the settle: the page must wait for the persisted preferences
 * before deciding, and must resume exactly once.
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
    resumeChatSession: vi.fn(),
    streamChat: vi.fn(),
  };
});

// Returns a NON-NULL key on purpose: hydrating it flips `agentKey`, which
// re-runs the session effect. That second pass is what used to mint a new
// session and overwrite the stored id, so a mock returning `null` here would
// make these tests pass even against the unfixed page.
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: () => <div data-testid="agent-picker" />,
  loadStoredAgentKey: () => "researcher",
  storeAgentKey: () => undefined,
}));

vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => null,
}));

// Deliberately reports the REAL contract, including the hydration flag.
vi.mock("@/components/chat/project-scope-selector", () => ({
  ProjectScopeSelector: () => <div data-testid="project-scope-selector" />,
  useProjectScope: () => ({
    scope: { mode: "all", projectIds: [] },
    setScope: () => {},
    hydrated: true,
  }),
}));

const createMock = vi.mocked(aiClient.createSessionWithScope);
const resumeMock = vi.mocked(aiClient.resumeChatSession);
const useSearchParamsMock = vi.mocked(useSearchParams);

const storedSession: aiClient.AISession = {
  id: "sess-stored",
  title: "New Chat",
  createdAt: new Date().toISOString(),
} as aiClient.AISession;

describe("<ChatPage /> — restore on bare /chat (#1367)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSearchParamsMock.mockReturnValue(new URLSearchParams() as never);
    createMock.mockResolvedValue({ session: { ...storedSession, id: "sess-new" } } as never);
  });

  it("resumes the stored session instead of minting a new one", async () => {
    aiClient.storeActiveSessionId("sess-stored");
    resumeMock.mockResolvedValue({
      session: storedSession,
      messages: [{ role: "user", content: "earlier question" }],
    } as never);

    render(<ChatPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(resumeMock).toHaveBeenCalledWith("sess-stored"));
    await waitFor(() => expect(screen.getByText(/earlier question/i)).toBeInTheDocument());
    // The defect: a second, session-creating pass after the preferences settled.
    expect(createMock).not.toHaveBeenCalled();
    expect(aiClient.loadActiveSessionId()).toBe("sess-stored");
  });

  it("creates exactly one session when there is nothing to resume", async () => {
    render(<ChatPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("falls back to creating one session when the stored id is stale", async () => {
    aiClient.storeActiveSessionId("sess-gone");
    resumeMock.mockResolvedValue(null as never);

    render(<ChatPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(resumeMock).toHaveBeenCalledWith("sess-gone");
  });
});
