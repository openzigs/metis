/**
 * #2350 — the chat page's side of "Ask about this" and "Advanced".
 *
 *   - `?about=<kind>:<id>` asks the server what the item is; on an answer, the
 *     chat opens scoped to the item's project, says what it is about, and the
 *     composer holds a question about it. On a refusal, nothing is scoped and
 *     the page says so. A chat opened this way never resumes the last chat.
 *   - For a non-admin, the agent picker, the provider · model line and the
 *     Session skills panel sit behind an "Advanced" toggle, off by default and
 *     remembered per user; the chat says which assistant answers in words. An
 *     admin sees the controls with no toggle.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import type { ChatSubjectDto } from "@metis/shared";
import { makeWrapper, TEST_USER } from "./test-utils";
import { acceptedTurn, sendChatMessage } from "./chat-send";
import ChatPage from "@/app/(authed)/chat/page";
import * as aiClient from "@/lib/ai-client";
import { getChatSubject } from "@/lib/chat-subject";
import type { AuthUser } from "@/lib/auth-types";

vi.mock("@/lib/ai-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-client")>("@/lib/ai-client");
  return {
    ...actual,
    createSessionWithScope: vi.fn(),
    listSessionAgents: vi.fn(async () => []),
    streamChat: vi.fn(),
    loadActiveSessionId: vi.fn(() => null),
    storeActiveSessionId: vi.fn(),
    resumeChatSession: vi.fn(async () => null),
    getTranscriptSince: vi.fn(async () => null),
  };
});

vi.mock("@/lib/chat-subject", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chat-subject")>("@/lib/chat-subject");
  return { ...actual, getChatSubject: vi.fn() };
});

let storedAgent: string | null = null;
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: ({ value }: { value: string | null }) => (
    <div data-testid="agent-picker">{value ?? "Default"}</div>
  ),
  loadStoredAgentKey: () => storedAgent,
  storeAgentKey: vi.fn(),
}));
vi.mock("@/components/chat/chat-history", () => ({ ChatHistory: () => null }));
vi.mock("@/components/chat/loaded-skills-panel", () => ({
  LoadedSkillsPanel: () => <div data-testid="skills-panel" />,
}));

// A stateful stand-in, so a scope the page sets is the scope it reads back.
const setScopeSpy = vi.fn();
vi.mock("@/components/chat/project-scope-selector", () => ({
  ProjectScopeSelector: ({
    value,
    onChange,
  }: {
    value: { projectIds: string[] };
    onChange: (s: { mode: "selected"; projectIds: string[] }) => void;
  }) => (
    <button
      type="button"
      data-testid="project-scope-selector"
      onClick={() => onChange({ mode: "selected", projectIds: ["proj-b"] })}
    >
      {value.projectIds.join(",") || "all"}
    </button>
  ),
  loadStoredScope: () => null,
  useProjectScope: () => {
    const [scope, setScope] = useState<{ mode: "all" | "selected"; projectIds: string[] }>({
      mode: "all",
      projectIds: [],
    });
    return {
      scope,
      setScope: (s: typeof scope) => {
        setScopeSpy(s);
        setScope(s);
      },
      hydrated: true,
    };
  },
}));

const createMock = vi.mocked(aiClient.createSessionWithScope);
const subjectMock = vi.mocked(getChatSubject);
const useSearchParamsMock = vi.mocked(useSearchParams);

const CR: ChatSubjectDto = {
  kind: "change-request",
  id: "cr-1",
  projectId: "proj-a",
  projectName: "Alpha",
  title: "Checkout v2",
  changeRequestTitle: null,
};

function session(projectId: string | null): aiClient.AISession {
  return {
    id: "sess-1",
    title: "New Chat",
    provider: "anthropic",
    model: "claude-x",
    policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
    status: "active",
    projectId,
    createdAt: "",
    updatedAt: "",
  };
}

const ANALYST: AuthUser = { ...TEST_USER, id: "u-analyst", role: "developer" };

function params(q: Record<string, string>) {
  useSearchParamsMock.mockReturnValue(new URLSearchParams(q) as ReturnType<typeof useSearchParams>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  storedAgent = null;
  params({});
  createMock.mockResolvedValue({ session: session("proj-a"), scope: null });
  vi.mocked(aiClient.streamChat).mockImplementation(acceptedTurn as typeof aiClient.streamChat);
});

describe("<ChatPage /> — Ask about this (#2350)", () => {
  it("opens scoped to the item's project, says what it is about, and seeds a question", async () => {
    params({ about: "change-request:cr-1" });
    subjectMock.mockResolvedValue(CR);
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });

    expect(await screen.findByTestId("chat-subject")).toHaveTextContent(
      "Asking about the change request “Checkout v2” in Alpha.",
    );
    expect(subjectMock).toHaveBeenCalledWith("change-request", "cr-1");
    expect(setScopeSpy).toHaveBeenCalledWith({ mode: "selected", projectIds: ["proj-a"] });
    // The scope is on screen, in the selector the analyst can change it with.
    expect(screen.getByTestId("project-scope-selector")).toHaveTextContent("proj-a");
    const box = screen.getByLabelText("Message") as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.value).toBe(
      "What does the change request “Checkout v2” ask for, and what would it affect?",
    );
    // A chat about the item is a new one: the chat last open here is not resumed.
    expect(aiClient.loadActiveSessionId).not.toHaveBeenCalled();
  });

  it("creates the session in the item's project on the first send", async () => {
    params({ about: "change-request:cr-1" });
    subjectMock.mockResolvedValue(CR);
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    await screen.findByTestId("chat-subject");
    await sendChatMessage("What does it change?");
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0]![0]).toMatchObject({ projectIds: ["proj-a"] });
  });

  it("drops the 'Asking about' line once the analyst moves the scope off the project", async () => {
    params({ about: "change-request:cr-1" });
    subjectMock.mockResolvedValue(CR);
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    await screen.findByTestId("chat-subject");
    fireEvent.click(screen.getByTestId("project-scope-selector"));
    await waitFor(() => expect(screen.queryByTestId("chat-subject")).not.toBeInTheDocument());
    expect(screen.getByTestId("project-scope-selector")).toHaveTextContent("proj-b");
  });

  it("says so, and scopes nothing, when the server refuses the item", async () => {
    params({ about: "requirement:req-x" });
    subjectMock.mockRejectedValue(new Error("Not found"));
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });

    expect(await screen.findByTestId("chat-subject-refused")).toHaveTextContent(
      /can’t ask about that item/,
    );
    expect(setScopeSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-subject")).not.toBeInTheDocument();
    const box = screen.getByLabelText("Message") as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.value).toBe("");
  });

  it("ignores a malformed about value without asking the server", async () => {
    params({ about: "workspace:ws-1" });
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    const box = screen.getByLabelText("Message") as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(subjectMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-subject-refused")).not.toBeInTheDocument();
  });
});

describe("<ChatPage /> — Advanced (#2350)", () => {
  it("hides the developer controls from a non-admin by default, and says who answers", async () => {
    storedAgent = "researcher";
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    const toggle = await screen.findByRole("switch", { name: "Advanced" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skills-panel")).not.toBeInTheDocument();
    expect(await screen.findByTestId("chat-assistant")).toHaveTextContent(
      "Answering: the METIS assistant, with the standard settings.",
    );

    // With Advanced off, the chat runs on the defaults: no stored agent is sent,
    // and no provider · model line is shown.
    createMock.mockResolvedValue({ session: session(null), scope: null });
    await sendChatMessage();
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const input = createMock.mock.calls[0]![0];
    expect(input).not.toHaveProperty("agentKey");
    expect(input).not.toHaveProperty("agentRef");
    await waitFor(() => expect(aiClient.streamChat).toHaveBeenCalled());
    expect(screen.queryByText("anthropic · claude-x")).not.toBeInTheDocument();
  });

  it("shows them once Advanced is on, and remembers the choice for that user", async () => {
    const first = render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    fireEvent.click(await screen.findByRole("switch", { name: "Advanced" }));
    expect(await screen.findByTestId("agent-picker")).toBeInTheDocument();
    expect(screen.getByTestId("skills-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-assistant")).not.toBeInTheDocument();
    first.unmount();

    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    expect(await screen.findByRole("switch", { name: "Advanced" })).toBeChecked();
    expect(await screen.findByTestId("agent-picker")).toBeInTheDocument();
  });

  it("remembers the choice per user: another analyst starts with it off", async () => {
    window.localStorage.setItem("metis.chat.advanced.u-analyst", "on");
    render(<ChatPage />, {
      wrapper: makeWrapper({ initialUser: { ...ANALYST, id: "u-other" } }),
    });
    expect(await screen.findByRole("switch", { name: "Advanced" })).not.toBeChecked();
    expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
  });

  it("turning Advanced off puts a picked agent back on the default", async () => {
    window.localStorage.setItem("metis.chat.advanced.u-analyst", "on");
    storedAgent = "researcher";
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: ANALYST }) });
    expect(await screen.findByTestId("agent-picker")).toHaveTextContent("researcher");
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Advanced" }));
    });
    expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
    await sendChatMessage();
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0]![0]).not.toHaveProperty("agentKey");
  });

  it("shows an admin every control as before, with no toggle", async () => {
    storedAgent = "researcher";
    render(<ChatPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(await screen.findByTestId("agent-picker")).toHaveTextContent("researcher");
    expect(screen.getByTestId("skills-panel")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Advanced" })).not.toBeInTheDocument();
    await sendChatMessage();
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0]![0]).toMatchObject({ agentKey: "researcher" });
    expect(await screen.findByText("anthropic · claude-x")).toBeInTheDocument();
  });
});
