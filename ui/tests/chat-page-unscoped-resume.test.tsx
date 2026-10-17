/**
 * PR #1234 review (P1) — the chat page with the REAL `useProjectScope`.
 *
 * #1139 opens `/chat` on the project active in the top bar, and that project
 * always exists for a user who has one (the switcher falls back to the first
 * listed). The #1367 restore tests mock the hook to "All projects", a state the
 * real hook cannot reach for such a user, so they could not see that a reload
 * of an "All projects" conversation threw it away. These do not mock the hook:
 * only the two project lists it reads are served.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { makeWrapper } from "./test-utils";
import { acceptedTurn, sendChatMessage } from "./chat-send";
import ChatPage from "@/app/(authed)/chat/page";
import * as aiClient from "@/lib/ai-client";
import { apiFetch } from "@/lib/api-client";
import { recentTracker } from "@/lib/recent-tracker";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSessionWithScope: vi.fn(),
    resumeChatSession: vi.fn(),
    streamChat: vi.fn(),
    getTranscriptSince: vi.fn(async (_id: string, afterOrdinal: number) => ({
      afterOrdinal,
      rows: [],
      compactionUpdates: [],
    })),
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

const PROJECTS = [
  { id: "p-1", name: "Alpha" },
  { id: "p-2", name: "Beta" },
];

const createMock = vi.mocked(aiClient.createSessionWithScope);
const resumeMock = vi.mocked(aiClient.resumeChatSession);

function storedSession(over: Partial<aiClient.AISession>): aiClient.AISession {
  return {
    id: "sess-stored",
    title: "Which tables hold invoices?",
    createdAt: new Date().toISOString(),
    projectId: null,
    ...over,
  } as aiClient.AISession;
}

/** What the selector stored when the user last picked a scope in chat. */
function lastPicked(scope: { mode: "all" | "selected"; projectIds: string[] }) {
  localStorage.setItem("metis.chat.projectScope", JSON.stringify(scope));
}

function selectorLabel(): string {
  return screen.getByTestId("project-scope-selector").textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  // `/projects` is the top bar's list; `/search/projects` the selector's.
  vi.mocked(apiFetch).mockImplementation(
    async (path: string) => (path === "/projects" ? { items: PROJECTS } : PROJECTS) as never,
  );
  createMock.mockResolvedValue({
    session: storedSession({ id: "sess-new", title: "New Chat", projectId: "p-2" }),
    scope: null,
  } as never);
  vi.mocked(aiClient.streamChat).mockImplementation(acceptedTurn as typeof aiClient.streamChat);
  // The top bar's active project.
  localStorage.setItem("metis.activeProjectId", "p-2");
});

describe("<ChatPage /> — reloading an 'All projects' conversation (PR #1234 P1)", () => {
  it("resumes it, in 'All projects', for a user who has an active project", async () => {
    lastPicked({ mode: "all", projectIds: [] });
    aiClient.storeActiveSessionId("sess-stored");
    resumeMock.mockResolvedValue({
      session: storedSession({}),
      messages: [{ role: "user", content: "an unscoped question", ordinal: 1 }],
    } as never);

    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => expect(screen.getByText(/an unscoped question/)).toBeInTheDocument());
    expect(aiClient.loadActiveSessionId()).toBe("sess-stored");
    await waitFor(() => expect(selectorLabel()).toContain("All projects"));
    // The resume survives the scope change it causes: still on screen.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/an unscoped question/)).toBeInTheDocument();

    // The next turn goes to the resumed session; nothing new is created.
    await sendChatMessage("a follow-up");
    await waitFor(() => expect(aiClient.streamChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(aiClient.streamChat).mock.calls[0]![0]).toBe("sess-stored");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("Recent lists the resumed session by its stored title, not by the follow-up", async () => {
    lastPicked({ mode: "all", projectIds: [] });
    aiClient.storeActiveSessionId("sess-stored");
    resumeMock.mockResolvedValue({
      session: storedSession({}),
      messages: [{ role: "user", content: "an unscoped question", ordinal: 1 }],
    } as never);
    const touch = vi.spyOn(recentTracker, "touch");

    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await waitFor(() => expect(screen.getByText(/an unscoped question/)).toBeInTheDocument());
    await sendChatMessage("a follow-up");
    await waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
    expect(touch.mock.calls[0]![0]).toMatchObject({
      id: "sess-stored",
      label: "Which tables hold invoices?",
    });
  });

  it("opens on the active project when a project was last picked here (AC1)", async () => {
    lastPicked({ mode: "selected", projectIds: ["p-1"] });
    aiClient.storeActiveSessionId("sess-stored");
    resumeMock.mockResolvedValue({
      session: storedSession({}),
      messages: [{ role: "user", content: "an unscoped question", ordinal: 1 }],
    } as never);

    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => expect(resumeMock).toHaveBeenCalledWith("sess-stored"));
    await waitFor(() => expect(screen.getByLabelText("Message")).not.toBeDisabled());
    expect(screen.queryByText(/an unscoped question/)).toBeNull();
    await waitFor(() => expect(selectorLabel()).toContain("Beta"));
  });

  it("a session of another project is still not resumed onto the active one", async () => {
    lastPicked({ mode: "all", projectIds: [] });
    aiClient.storeActiveSessionId("sess-stored");
    resumeMock.mockResolvedValue({
      session: storedSession({ projectId: "p-1" }),
      messages: [{ role: "user", content: "a question about Alpha", ordinal: 1 }],
    } as never);

    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => expect(resumeMock).toHaveBeenCalledWith("sess-stored"));
    await waitFor(() => expect(screen.getByLabelText("Message")).not.toBeDisabled());
    expect(screen.queryByText(/about Alpha/)).toBeNull();
    expect(aiClient.loadActiveSessionId()).toBeNull();
    await waitFor(() => expect(selectorLabel()).toContain("Beta"));
  });
});
