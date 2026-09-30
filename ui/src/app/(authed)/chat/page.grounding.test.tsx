/**
 * #18 — the chat page says what each answer is based on: a notice before the
 * turn when the session has no project (no retrieval will run), and a label
 * under every reply — live from the `grounding` frame, and after the transcript
 * re-read from the persisted row.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTranscriptSince = vi.fn();
const state = vi.hoisted(() => ({
  projectId: null as string | null,
  events: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-client")>();
  return {
    ...actual,
    loadActiveSessionId: () => null,
    storeActiveSessionId: vi.fn(),
    createSessionWithScope: vi.fn(async () => ({
      session: {
        id: "sess-1",
        title: "t",
        provider: "anthropic",
        model: "m",
        policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
        status: "active",
        projectId: state.projectId,
        createdAt: "",
        updatedAt: "",
      },
      scope: null,
    })),
    getTranscriptSince: (...a: unknown[]) => getTranscriptSince(...a),
    streamChat: async function* () {
      for (const ev of state.events) yield ev;
    },
  };
});
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
  useProjectScope: () => ({
    scope: { mode: "all", projectIds: [] },
    setScope: vi.fn(),
    hydrated: true,
  }),
}));
vi.mock("@/lib/recent-tracker", () => ({ recentTracker: { touch: vi.fn() } }));

const { default: ChatPage } = await import("./page");

const GROUNDED = { status: "grounded", projectId: "p1", projectName: "Payments", sources: 2 };

beforeEach(() => {
  getTranscriptSince.mockReset();
  state.projectId = null;
  state.events = [];
});

async function send(text: string) {
  await waitFor(() =>
    expect(screen.getByLabelText("Message")).not.toHaveProperty("disabled", true),
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("chat page — grounding (#18)", () => {
  it("tells the user before the turn that an unscoped chat is not grounded", async () => {
    render(<ChatPage />);
    const notice = await screen.findByTestId("chat-ungrounded-notice");
    expect(notice.textContent).toMatch(/does not search your projects/);
  });

  it("shows no such notice for a session bound to a project", async () => {
    state.projectId = "p1";
    render(<ChatPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("Message")).not.toHaveProperty("disabled", true),
    );
    expect(screen.queryByTestId("chat-ungrounded-notice")).toBeNull();
  });

  it("labels the reply from the grounding frame while the transcript is still being read", async () => {
    state.projectId = "p1";
    state.events = [
      { type: "grounding", grounding: GROUNDED },
      { type: "delta", content: "answer" },
      { type: "done" },
    ];
    getTranscriptSince.mockReturnValue(new Promise(() => undefined)); // never lands
    render(<ChatPage />);
    await send("q");
    const badge = await screen.findByTestId("chat-grounding");
    expect(badge.textContent).toBe("Grounded in Payments · 2 sources");
  });

  it("keeps each reply's label after the transcript re-read, from the persisted rows", async () => {
    state.events = [
      { type: "grounding", grounding: { status: "unscoped" } },
      { type: "delta", content: "answer" },
      { type: "done" },
    ];
    getTranscriptSince.mockResolvedValue({
      afterOrdinal: 0,
      rows: [
        { role: "user", content: "q", ordinal: 1, compacted: false },
        {
          role: "assistant",
          content: "server answer",
          ordinal: 2,
          compacted: false,
          grounding: { status: "unscoped" },
        },
      ],
      compactionUpdates: [],
    });
    render(<ChatPage />);
    await send("q");
    const reply = (await screen.findByText("server answer")).closest("li")!;
    expect(within(reply).getByTestId("chat-grounding")).toHaveAttribute(
      "data-grounding",
      "unscoped",
    );
    // The user's own message carries no label.
    const question = screen.getByText("q").closest("li")!;
    expect(within(question).queryByTestId("chat-grounding")).toBeNull();
  });
});
