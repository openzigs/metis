/**
 * Epic #459 — Chat UX refinements.
 *  - #460: Stop button cancels an in-flight stream (aborts the controller),
 *          and the streaming region is an aria-live log.
 *  - #461: Guided empty state renders suggested-prompt cards that seed input.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const createSessionMock = vi.mocked(aiClient.createSessionWithScope);
const streamChatMock = vi.mocked(aiClient.streamChat);
const useSearchParamsMock = vi.mocked(useSearchParams);

const fakeSession: aiClient.AISession = {
  id: "sess-1",
  title: "New Chat",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
  status: "active",
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  createSessionMock.mockResolvedValue({ session: fakeSession, scope: null });
  useSearchParamsMock.mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>);
});

describe("<ChatPage /> — guided empty state (#461)", () => {
  it("renders suggested-prompt cards once the session is ready", async () => {
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(await screen.findByText("Summarize a project")).toBeInTheDocument();
    expect(screen.getByText("Find recent changes")).toBeInTheDocument();
  });

  it("seeds the message input when a suggested prompt is clicked", async () => {
    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    const card = await screen.findByText("Summarize a project");
    await user.click(card);
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Give me a high-level summary of this project."));
  });

  it("marks the transcript region as an aria-live log", async () => {
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await screen.findByText("Summarize a project");
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  // Issue #58 — screen-reader audit. Beyond the live transcript, the message
  // input must carry an accessible name and the skills sidebar must be a
  // labelled complementary region so SR users can orient without visual cues.
  it("names the message input and labels the skills sidebar (#58)", async () => {
    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await screen.findByText("Summarize a project");
    expect(screen.getByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Session skills" })).toBeInTheDocument();
  });
});

describe("<ChatPage /> — Stop button (#460)", () => {
  it("shows Stop while streaming and aborts the controller on click", async () => {
    const user = userEvent.setup();
    // A never-resolving async iterable so the component stays in the streaming
    // state; aborting is observable via signal.aborted.
    let captured: AbortSignal | undefined;
    streamChatMock.mockImplementation(((_id: string, _msgs: unknown, signal: AbortSignal) => {
      captured = signal;
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      };
    }) as unknown as typeof aiClient.streamChat);

    render(<ChatPage />, { wrapper: makeWrapper({ withAuth: false }) });
    const input = (await screen.findByLabelText("Message")) as HTMLInputElement;
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(captured?.aborted).toBe(false);
    await user.click(stop);
    expect(captured?.aborted).toBe(true);
  });
});
