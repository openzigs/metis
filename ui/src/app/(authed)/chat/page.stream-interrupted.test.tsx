/**
 * #1573 — a turn the server accepted whose stream the browser cut off
 * (`net::ERR_ABORTED`) is still answered on the server. The page keeps the
 * question on screen and re-reads the turn until the answer is on record,
 * instead of reading once, finding nothing yet, and blanking the turn. A turn
 * the user stopped is read once, as before.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptDelta } from "@/lib/ai-client";

const state = vi.hoisted(() => ({
  reads: [] as TranscriptDelta[],
  readCount: 0,
  stream: null as null | ((signal?: AbortSignal, onAccepted?: () => void) => AsyncGenerator),
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
    getTranscriptSince: async () => {
      state.readCount += 1;
      return state.reads.length > 1 ? state.reads.shift()! : state.reads[0]!;
    },
    // The real poll, without the real wait between reads.
    awaitTurnReply: (
      read: Parameters<typeof actual.awaitTurnReply>[0],
      opts: Parameters<typeof actual.awaitTurnReply>[1],
    ) => actual.awaitTurnReply(read, { ...opts, intervalMs: 1 }),
    streamChat: (
      _id: string,
      _message: string,
      signal?: AbortSignal,
      _idle?: number,
      onAccepted?: () => void,
    ) => state.stream!(signal, onAccepted),
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

const QUESTION = "Which table holds orders?";
const row = (role: "user" | "assistant", content: string, ordinal: number) => ({
  role,
  content,
  ordinal,
  compacted: false,
});
const delta = (rows: ReturnType<typeof row>[]): TranscriptDelta => ({
  afterOrdinal: 0,
  rows,
  compactionUpdates: [],
});

beforeEach(() => {
  state.readCount = 0;
  state.reads = [];
  state.stream = null;
});

async function send(text: string) {
  await waitFor(() =>
    expect(screen.getByLabelText("Message")).not.toHaveProperty("disabled", true),
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("chat page — a turn cut off client-side (#1573)", () => {
  it("keeps the question and shows the answer once the server has it", async () => {
    state.stream = async function* (_signal, onAccepted) {
      onAccepted?.();
      // The browser cut the request; this page's controller was not aborted.
      throw new DOMException("The user aborted a request.", "AbortError");
    };
    state.reads = [
      delta([]),
      delta([row("user", QUESTION, 1)]),
      delta([row("user", QUESTION, 1), row("assistant", "The orders table.", 2)]),
    ];
    render(<ChatPage />);
    await send(QUESTION);

    expect(await screen.findByText("The orders table.")).toBeTruthy();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(state.readCount).toBe(3);
    // Not an error: nothing failed, the answer was only late.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads a turn the user stopped once, and does not wait for a reply", async () => {
    state.stream = async function* (signal, onAccepted) {
      onAccepted?.();
      yield { type: "delta", content: "partial" };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw new DOMException("aborted", "AbortError");
    };
    state.reads = [delta([row("user", QUESTION, 1)])];
    render(<ChatPage />);
    await send(QUESTION);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(state.readCount).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(state.readCount).toBe(1);
  });

  it("still ends the turn in flight when the page is left", async () => {
    let seen: AbortSignal | undefined;
    state.stream = async function* (signal, onAccepted) {
      seen = signal;
      onAccepted?.();
      yield { type: "delta", content: "partial" };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    };
    state.reads = [delta([])];
    const { unmount } = render(<ChatPage />);
    await send(QUESTION);
    await screen.findByRole("button", { name: "Stop" });
    expect(seen?.aborted).toBe(false);
    unmount();
    expect(seen?.aborted).toBe(true);
  });
});
