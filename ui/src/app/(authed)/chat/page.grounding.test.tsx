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

  it("#464 — a later grounding frame replaces the earlier one on the live reply", async () => {
    state.projectId = "p1";
    const noContext = { status: "no-context", projectId: "p1", projectName: "Payments" };
    state.events = [
      // First what auto-retrieval supplied (nothing) …
      { type: "grounding", grounding: noContext },
      { type: "tool_call", name: "search-knowledge", arguments: { query: "dns" } },
      { type: "delta", content: "answer" },
      // … then, after the tool loop, what the tools read of the project.
      {
        type: "grounding",
        grounding: { ...noContext, status: "grounded", sources: 0, toolReads: 2 },
      },
      { type: "done" },
    ];
    getTranscriptSince.mockReturnValue(new Promise(() => undefined)); // never lands
    render(<ChatPage />);
    await send("q");
    const reply = (await screen.findByText("answer")).closest("li")!;
    await waitFor(() =>
      expect(within(reply).getByTestId("chat-grounding")).toHaveAttribute(
        "data-grounding",
        "grounded",
      ),
    );
    // Exactly one badge: the second frame replaced the first, it did not add one.
    expect(within(reply).getAllByTestId("chat-grounding")).toHaveLength(1);
    expect(within(reply).getByTestId("chat-grounding").textContent).toBe(
      "Grounded in Payments · 2 project lookups",
    );
  });

  describe("#439 — no grounding badge under a reply that did not finish", () => {
    it("hides the live badge when the stream fails after part of the answer", async () => {
      state.projectId = "p1";
      state.events = [
        { type: "grounding", grounding: GROUNDED },
        { type: "delta", content: "partial answer" },
        { type: "error", code: "AI_PROVIDER_ERROR", message: "the provider dropped it" },
      ];
      getTranscriptSince.mockReturnValue(new Promise(() => undefined));
      render(<ChatPage />);
      await send("q");
      const reply = (await screen.findByText("partial answer")).closest("li")!;
      await within(reply).findByTestId("incomplete-answer-notice");
      expect(within(reply).queryByTestId("chat-grounding")).toBeNull();
    });

    it("hides the live badge when the stream fails before any answer", async () => {
      state.projectId = "p1";
      state.events = [
        { type: "grounding", grounding: GROUNDED },
        { type: "error", code: "AI_PROVIDER_ERROR", message: "the provider refused" },
      ];
      getTranscriptSince.mockReturnValue(new Promise(() => undefined));
      render(<ChatPage />);
      await send("q");
      // The reply renders the error as "⚠ <message>"; the page banner repeats it.
      const reply = (await screen.findByText("⚠ the provider refused")).closest("li")!;
      expect(within(reply).queryByTestId("chat-grounding")).toBeNull();
    });

    it("hides the badge on an incomplete reply read back from the transcript", async () => {
      state.events = [{ type: "delta", content: "answer" }, { type: "done" }];
      getTranscriptSince.mockResolvedValue({
        afterOrdinal: 0,
        rows: [
          { role: "user", content: "q", ordinal: 1, compacted: false },
          {
            role: "assistant",
            content: "cut short",
            ordinal: 2,
            compacted: false,
            incomplete: "The response was stopped before it finished.",
            grounding: GROUNDED,
          },
        ],
        compactionUpdates: [],
      });
      render(<ChatPage />);
      await send("q");
      const reply = (await screen.findByText("cut short")).closest("li")!;
      expect(within(reply).getByTestId("incomplete-answer-notice")).toBeTruthy();
      expect(within(reply).queryByTestId("chat-grounding")).toBeNull();
    });
  });
});
