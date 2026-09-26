/**
 * #149 — a read-only (copilot-native) session's notice belongs to THAT session.
 *
 * Changing the agent or the project re-runs the page's session-load effect,
 * which mints a fresh, writable session. The effect must clear the read-only
 * reason as part of its per-session reset; otherwise the new session stays
 * locked behind the old session's notice until a reload. "New chat" has its
 * own test in `chat-page-session-restore.test.tsx` — this file pins the
 * effect-driven path, which that test does not reach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// A picker the test can drive: one click is "the user chose another agent".
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: ({ onChange }: { onChange: (key: string) => void }) => (
    <button type="button" data-testid="pick-architect" onClick={() => onChange("architect")}>
      pick architect
    </button>
  ),
  loadStoredAgentKey: () => "researcher",
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
    hydrated: true,
  }),
}));

const createMock = vi.mocked(aiClient.createSessionWithScope);
const resumeMock = vi.mocked(aiClient.resumeChatSession);
const useSearchParamsMock = vi.mocked(useSearchParams);

const storedSession = {
  id: "sess-stored",
  title: "New Chat",
  createdAt: new Date().toISOString(),
} as aiClient.AISession;

const READ_ONLY_REASON =
  'This chat session was created with AI provider "copilot-native", but GitHub Copilot support was removed from METIS.';

async function renderReadOnlySession() {
  aiClient.storeActiveSessionId("sess-stored");
  resumeMock.mockResolvedValue({
    session: storedSession,
    messages: [{ role: "user", content: "earlier question", ordinal: 1 }],
    readOnlyReason: READ_ONLY_REASON,
  } as never);
  const view = render(<ChatPage />, { wrapper: makeWrapper() });
  await waitFor(() => expect(screen.getByTestId("chat-read-only-notice")).toBeInTheDocument());
  expect(screen.getByLabelText("Message")).toBeDisabled();
  expect(createMock).not.toHaveBeenCalled();
  return view;
}

function expectWritableFreshSession(): void {
  expect(screen.queryByTestId("chat-read-only-notice")).toBeNull();
  expect(screen.getByLabelText("Message")).not.toBeDisabled();
  expect(screen.queryByText(/earlier question/i)).toBeNull();
}

describe("<ChatPage /> — a read-only session's notice clears on an agent / project change (#149)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSearchParamsMock.mockReturnValue(new URLSearchParams() as never);
    createMock.mockResolvedValue({ session: { ...storedSession, id: "sess-new" } } as never);
  });

  it("changing the agent starts a writable session without the old notice", async () => {
    await renderReadOnlySession();

    fireEvent.click(screen.getByTestId("pick-architect"));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ agentKey: "architect" }));
    await waitFor(() => expect(aiClient.loadActiveSessionId()).toBe("sess-new"));
    expectWritableFreshSession();
  });

  it("changing the project starts a writable session without the old notice", async () => {
    const view = await renderReadOnlySession();

    useSearchParamsMock.mockReturnValue(new URLSearchParams("projectId=proj-2") as never);
    view.rerender(<ChatPage />);

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-2" }));
    await waitFor(() => expect(aiClient.loadActiveSessionId()).toBe("sess-new"));
    expectWritableFreshSession();
  });
});
