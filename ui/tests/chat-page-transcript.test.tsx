/**
 * Epic #127 — the chat page on the server-owned transcript:
 *   • a turn sends ONLY the new message (#136);
 *   • after the turn the page re-renders from the server transcript (#136);
 *   • compacted rows stay visible and a summary renders as a note (#138);
 *   • "Fork from here" forks at that reply and opens the fork (#139).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { makeWrapper } from "./test-utils";
import ChatPage from "@/app/(authed)/chat/page";
import * as aiClient from "@/lib/ai-client";
import type { StreamEvent } from "@/lib/ai-client";

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSessionWithScope: vi.fn(),
    resumeChatSession: vi.fn(),
    streamChat: vi.fn(),
    getTranscript: vi.fn(),
    forkChatSession: vi.fn(),
  };
});
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: () => null,
  loadStoredAgentKey: () => null,
  storeAgentKey: () => undefined,
}));
vi.mock("@/components/chat/loaded-skills-panel", () => ({ LoadedSkillsPanel: () => null }));
vi.mock("@/components/chat/project-scope-selector", () => ({
  ProjectScopeSelector: () => null,
  useProjectScope: () => ({
    scope: { mode: "all", projectIds: [] },
    setScope: () => {},
    hydrated: true,
  }),
}));
vi.mock("@/lib/recent-tracker", () => ({ recentTracker: { touch: vi.fn() } }));

const createMock = vi.mocked(aiClient.createSessionWithScope);
const resumeMock = vi.mocked(aiClient.resumeChatSession);
const streamMock = vi.mocked(aiClient.streamChat);
const transcriptMock = vi.mocked(aiClient.getTranscript);
const forkMock = vi.mocked(aiClient.forkChatSession);

const session = {
  id: "sess-1",
  title: "New Chat",
  provider: "p",
  model: "m",
  projectId: null,
} as aiClient.AISession;

describe("<ChatPage /> on the server transcript (#127)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    createMock.mockResolvedValue({ session, scope: null });
  });

  it("sends only the new message, then renders the server transcript with a fork control", async () => {
    resumeMock.mockResolvedValue({
      session,
      messages: [
        { role: "user", content: "earlier q", ordinal: 1, compacted: true },
        {
          role: "summary",
          content: "the summary",
          ordinal: 3,
          compacted: false,
          summaryOf: { fromOrdinal: 1, toOrdinal: 2, messageCount: 2 },
        },
      ],
    });
    aiClient.storeActiveSessionId("sess-1");
    async function* reply(): AsyncGenerator<StreamEvent> {
      yield { type: "compaction", compaction: { compactedMessages: 2 } as never };
      yield { type: "delta", content: "live answer" };
      yield { type: "done" };
    }
    streamMock.mockReturnValue(reply());
    transcriptMock.mockResolvedValue([
      { role: "user", content: "earlier q", ordinal: 1, compacted: true },
      { role: "summary", content: "the summary", ordinal: 3, compacted: false },
      { role: "user", content: "new q", ordinal: 4, compacted: false },
      { role: "assistant", content: "server answer", ordinal: 5, compacted: false },
    ]);

    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByText(/earlier q/)).toBeInTheDocument());
    expect(screen.getByTestId("chat-summary")).toHaveTextContent("the summary");
    expect(screen.getByText("summarised")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Message" }), "new q");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(streamMock).toHaveBeenCalled());
    expect(streamMock.mock.calls[0]![0]).toBe("sess-1");
    expect(streamMock.mock.calls[0]![1]).toBe("new q");
    await waitFor(() => expect(screen.getByText("server answer")).toBeInTheDocument());
    expect(transcriptMock).toHaveBeenCalledWith("sess-1");
    expect(screen.getByTestId("chat-compaction-note")).toHaveTextContent("Older messages (2)");
    expect(screen.getByTestId("chat-fork-5")).toBeInTheDocument();
  });

  it("'Fork from here' forks at that reply and opens the new session", async () => {
    resumeMock.mockResolvedValue({
      session,
      messages: [
        { role: "user", content: "q", ordinal: 1, compacted: false },
        { role: "assistant", content: "a", ordinal: 2, compacted: false },
      ],
    });
    aiClient.storeActiveSessionId("sess-1");
    forkMock.mockResolvedValue({ session: { id: "sess-fork" }, copiedMessages: 2 } as never);
    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: makeWrapper() });
    await user.click(await screen.findByTestId("chat-fork-2"));
    await waitFor(() => expect(forkMock).toHaveBeenCalledWith("sess-1", 2));
    expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith("/chat?sessionId=sess-fork");
    expect(aiClient.loadActiveSessionId()).toBe("sess-fork");
  });

  it("a failed fork shows the error", async () => {
    resumeMock.mockResolvedValue({
      session,
      messages: [{ role: "assistant", content: "a", ordinal: 2, compacted: false }],
    });
    aiClient.storeActiveSessionId("sess-1");
    forkMock.mockRejectedValue(new Error("A fork must start from an assistant reply"));
    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: makeWrapper() });
    await user.click(await screen.findByTestId("chat-fork-2"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A fork must start");
  });
});
