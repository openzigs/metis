/**
 * #1139 — a provider stream that drops mid-reply. The server retries it once
 * from the last completed step and sends a `retry` frame: the page takes back
 * what the dropped attempt had streamed and says what is happening. A turn that
 * still fails keeps its partial answer and offers **Retry**, which asks the
 * same question again.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  turns: [] as unknown[][],
  sent: [] as string[],
  /** When set, the stream stays open after its frames until this settles. */
  hold: null as Promise<void> | null,
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
        title: "New Chat",
        provider: "anthropic",
        model: "m",
        policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
        status: "active",
        projectId: "p1",
        createdAt: "",
        updatedAt: "",
      },
      scope: null,
    })),
    // Never lands: the page keeps what it rendered from the stream.
    getTranscriptSince: () => new Promise(() => undefined),
    streamChat: async function* (_id: string, message: string) {
      state.sent.push(message);
      for (const ev of state.turns.shift() ?? []) yield ev;
      if (state.hold) await state.hold;
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
    scope: { mode: "selected", projectIds: ["p1"] },
    setScope: vi.fn(),
    hydrated: true,
  }),
}));
vi.mock("@/lib/recent-tracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recent-tracker")>()),
  recentTracker: { touch: vi.fn() },
}));

const { default: ChatPage } = await import("./page");

beforeEach(() => {
  state.turns = [];
  state.sent = [];
  state.hold = null;
});

async function send(text: string) {
  await waitFor(() => expect(screen.getByLabelText("Message")).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

const RETRY_NOTE = "The connection to the model dropped mid-reply, so METIS is asking again.";

describe("chat page — #1139 a dropped model stream", () => {
  it("takes back what the dropped attempt streamed and continues the answer", async () => {
    state.turns = [
      [
        { type: "delta", content: "Let me look." },
        { type: "delta", content: "\n\nBoth tab" },
        { type: "retry", keepChars: "Let me look.".length, message: RETRY_NOTE },
        { type: "delta", content: "\n\nBoth tables have 7 rows." },
        { type: "done" },
      ],
    ];
    render(<ChatPage />);
    await send("how many rows?");
    const reply = (await screen.findByText(/Both tables have 7 rows\./)).closest("li")!;
    expect(reply.textContent).not.toMatch(/Both tab(?!les)/);
    expect(reply.textContent).toContain("Let me look.");
    // The note belongs to the turn in flight; it is gone once the turn ends.
    await waitFor(() => expect(screen.queryByTestId("chat-retry-note")).toBeNull());
    expect(screen.queryByTestId("chat-retry-turn")).toBeNull();
  });

  it("shows the retry note until the retried answer starts (or the turn ends)", async () => {
    let release: () => void = () => undefined;
    state.hold = new Promise<void>((r) => (release = r));
    state.turns = [
      [
        { type: "delta", content: "Partial" },
        { type: "retry", keepChars: 0, message: RETRY_NOTE },
      ],
    ];
    render(<ChatPage />);
    await send("q");
    expect((await screen.findByTestId("chat-retry-note")).textContent).toBe(RETRY_NOTE);
    expect(screen.queryByText("Partial")).toBeNull();
    release();
    await waitFor(() => expect(screen.queryByTestId("chat-retry-note")).toBeNull());
  });

  it("a failed turn keeps its partial answer and Retry asks the same question again", async () => {
    state.turns = [
      [
        { type: "delta", content: "There are" },
        {
          type: "error",
          code: "AI_PROVIDER_ERROR",
          message: "anthropic stream failed (Error): terminated",
        },
      ],
      [{ type: "delta", content: "There are 7 rows." }, { type: "done" }],
    ];
    render(<ChatPage />);
    await send("how many rows?");
    const reply = (await screen.findByText("There are")).closest("li")!;
    expect(within(reply).getByTestId("incomplete-answer-notice").textContent).toMatch(/terminated/);
    fireEvent.click(within(reply).getByTestId("chat-retry-turn"));
    await screen.findByText("There are 7 rows.");
    expect(state.sent).toEqual(["how many rows?", "how many rows?"]);
    // The failed answer is still on screen above the new one.
    expect(screen.getByText("There are")).toBeTruthy();
    // Retry is offered on the LAST reply only, and this one finished.
    expect(screen.queryByTestId("chat-retry-turn")).toBeNull();
  });

  it("offers Retry on a turn that failed before any answer", async () => {
    state.turns = [[{ type: "error", message: "the provider refused" }]];
    render(<ChatPage />);
    await send("q");
    await screen.findByText("⚠ the provider refused");
    expect(screen.getByTestId("chat-retry-turn")).toBeTruthy();
  });
});
