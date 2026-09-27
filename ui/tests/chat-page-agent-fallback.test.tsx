/**
 * #236 review — a custom agent saved in the browser (`custom:<id>`) belongs to
 * the project it was picked in. Opening a project that neither owns nor enables
 * it used to fail session creation (404 AGENT_NOT_FOUND) with nothing clearing
 * the stored choice, so every visit failed again. The page now checks the saved
 * choice against the project's own list, falls back to the default agent,
 * clears the choice and tells the user once — without creating a second session.
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
    listSessionAgents: vi.fn(),
    streamChat: vi.fn(),
  };
});

const storeAgentKey = vi.fn();
let storedAgent: string | null = null;
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: ({ value }: { value: string | null }) => (
    <div data-testid="agent-picker">{value ?? "Default"}</div>
  ),
  loadStoredAgentKey: () => storedAgent,
  storeAgentKey: (v: string | null) => storeAgentKey(v),
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
const listMock = vi.mocked(aiClient.listSessionAgents);
const useSearchParamsMock = vi.mocked(useSearchParams);

const fakeSession: aiClient.AISession = {
  id: "sess-a",
  title: "New Chat",
  provider: "offline-stub",
  model: "stub-model",
  policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
  status: "active",
  projectId: "proj-a",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const agentOfA: aiClient.BindableAgent = {
  ref: "custom:ag-a",
  kind: "custom",
  key: "ag-a",
  name: "Agent A",
  description: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  storedAgent = "custom:ag-b";
  useSearchParamsMock.mockReturnValue(
    new URLSearchParams({ projectId: "proj-a" }) as ReturnType<typeof useSearchParams>,
  );
  createMock.mockResolvedValue({ session: fakeSession, scope: null });
});

/** Let every pending effect and promise settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("<ChatPage /> — a saved custom agent this project cannot bind (#236)", () => {
  it("creates the session with the default agent, clears the choice, and says so once", async () => {
    listMock.mockResolvedValue([agentOfA]); // proj-a does not offer custom:ag-b
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });

    const notice = await screen.findByTestId("chat-agent-fallback-notice");
    expect(notice).toHaveTextContent(/default agent/i);
    expect(listMock).toHaveBeenCalledWith("proj-a");
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0]![0];
    expect(arg).not.toHaveProperty("agentRef");
    expect(arg).not.toHaveProperty("agentKey");
    expect(arg.projectId).toBe("proj-a");
    expect(storeAgentKey).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("agent-picker")).toHaveTextContent("Default");

    // Clearing the choice must NOT start a second session for this chat.
    await settle();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("chat-agent-fallback-notice")).toHaveLength(1);
  });

  it("falls back the same way when the server refused the agent and the client retried", async () => {
    // A stale URL project: its listing 404s, so the choice is sent and the
    // client's one retry (ai-client) reports the agent it dropped.
    listMock.mockRejectedValue(new Error("Project not found"));
    createMock.mockResolvedValue({
      session: { ...fakeSession, projectId: null },
      scope: null,
      droppedAgentRef: "custom:ag-b",
    });
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });

    expect(await screen.findByTestId("chat-agent-fallback-notice")).toBeInTheDocument();
    expect(createMock.mock.calls[0]![0].agentRef).toBe("custom:ag-b");
    expect(storeAgentKey).toHaveBeenCalledWith(null);
    await settle();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a saved custom agent the project does offer", async () => {
    storedAgent = "custom:ag-a";
    listMock.mockResolvedValue([agentOfA]);
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0]![0].agentRef).toBe("custom:ag-a");
    await settle();
    expect(screen.queryByTestId("chat-agent-fallback-notice")).not.toBeInTheDocument();
    expect(storeAgentKey).not.toHaveBeenCalledWith(null);
  });
});
