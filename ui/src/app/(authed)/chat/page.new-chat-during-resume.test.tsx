/**
 * #1581 — `/chat` resumes the chat last open on this device, and the resume
 * takes a moment. **New chat** pressed in that moment used to be overridden:
 * the old conversation landed on top of the new one ~1.5 s later, so the next
 * question went to the wrong session. Only the HTTP layer is substituted.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const storeActiveSessionId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/ai-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-client")>()),
  loadActiveSessionId: () => "sess-last",
  storeActiveSessionId,
}));
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));
vi.mock("@/components/chat/agent-picker", () => ({
  AgentPicker: () => null,
  loadStoredAgentKey: () => null,
  storeAgentKey: vi.fn(),
}));
vi.mock("@/components/chat/loaded-skills-panel", () => ({ LoadedSkillsPanel: () => null }));
vi.mock("@/components/chat/project-scope-selector", () => ({
  ProjectScopeSelector: () => null,
  loadStoredScope: () => ({ mode: "all", projectIds: [] }),
  useProjectScope: () => ({
    scope: { mode: "all", projectIds: [] },
    setScope: vi.fn(),
    hydrated: true,
  }),
}));
vi.mock("@/lib/recent-tracker", () => ({ recentTracker: { touch: vi.fn() } }));

const { default: ChatPage } = await import("./page");

const OLD_QUESTION = "a question from the chat last open here";

function resumed() {
  return {
    session: { id: "sess-last", readOnlyReason: null },
    messages: [
      {
        id: "m1",
        ordinal: 1,
        role: "user",
        kind: "message",
        parts: [{ type: "text", text: OLD_QUESTION }],
        tokens: { estimated: 1, input: null, output: null, cacheRead: null, cacheWrite: null },
        provider: null,
        model: null,
        finishReason: null,
        compactedAt: null,
        compactedIntoId: null,
        summaryOf: null,
        incomplete: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    hasMore: false,
  };
}

let releaseResume: () => void = () => undefined;

beforeEach(() => {
  apiFetch.mockReset();
  storeActiveSessionId.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/ai/sessions/sess-last/resume") {
      // Held until the test lets it finish, as a slow resume.
      await new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
      return resumed();
    }
    if (path === "/ai/sessions/sess-last") {
      return {
        session: {
          id: "sess-last",
          title: "t",
          provider: "offline-stub",
          model: "m",
          projectId: null,
        },
      };
    }
    return {};
  });
});

async function settle() {
  // Let every pending promise in the resume chain run.
  for (let i = 0; i < 10; i++) await act(async () => undefined);
}

describe("chat page — New chat while the last chat is still resuming (#1581)", () => {
  it("keeps the new chat: the resume that finishes afterwards is dropped", async () => {
    render(<ChatPage />);
    await settle();
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/sess-last/resume", { method: "POST" });

    fireEvent.click(screen.getByTestId("chat-new-session"));
    releaseResume();
    await settle();

    expect(screen.queryByText(OLD_QUESTION)).toBeNull();
    expect(screen.getByTestId("chat-new-session-hint")).toBeInTheDocument();
    // The old chat is not re-recorded as the one open here.
    expect(storeActiveSessionId).not.toHaveBeenCalledWith("sess-last");
    expect(storeActiveSessionId).toHaveBeenCalledWith(null);
  });

  it("without New chat, the same slow resume still restores the last chat", async () => {
    render(<ChatPage />);
    await settle();
    releaseResume();
    expect(await screen.findByText(OLD_QUESTION)).toBeInTheDocument();
    expect(storeActiveSessionId).toHaveBeenCalledWith("sess-last");
  });
});
