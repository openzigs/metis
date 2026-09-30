/**
 * #422 — Chat records a session in Recent only after the server has ACCEPTED a
 * turn (#390's rule for the Workbench). A refused send stored no turn, so it
 * must not reach Recent; an accepted send did, even when it is stopped or
 * dropped before the first frame arrives.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StreamImpl = (
  sessionId: string,
  message: string,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
  onAccepted?: () => void,
) => AsyncGenerator<unknown>;

let streamImpl: StreamImpl;
const touch = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("projectId=proj-1"),
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
        projectId: "proj-1",
        createdAt: "",
        updatedAt: "",
      },
      scope: null,
    })),
    getTranscriptSince: vi.fn(async (_id: string, afterOrdinal: number) => ({
      afterOrdinal,
      rows: [],
      compactionUpdates: [],
    })),
    streamChat: (...args: Parameters<StreamImpl>) => streamImpl(...args),
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
vi.mock("@/lib/recent-tracker", () => ({
  recentTracker: { touch: (...a: unknown[]) => touch(...a) },
}));

const { default: ChatPage } = await import("./page");

beforeEach(() => {
  touch.mockReset();
});

async function send(text: string) {
  await waitFor(() =>
    expect(screen.getByLabelText("Message")).not.toHaveProperty("disabled", true),
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

async function idle() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
}

describe("chat page — Recent keys on an accepted turn (#422)", () => {
  it("records an answered turn, with a link Chat can resume", async () => {
    streamImpl = async function* (_id, _msg, _signal, _idle, onAccepted) {
      onAccepted?.();
      yield { type: "delta", content: "hello back" };
      yield { type: "done" };
    };
    render(<ChatPage />);
    await send("hi");
    await waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
    expect(touch).toHaveBeenCalledWith({
      kind: "session",
      id: "sess-1",
      label: "t",
      href: "/chat?sessionId=sess-1",
      projectId: "proj-1",
    });
  });

  it("a refused send does not reach Recent", async () => {
    streamImpl = async function* () {
      throw new Error("HTTP 409");
    };
    render(<ChatPage />);
    await send("refused");
    expect(await screen.findByText(/HTTP 409/)).toBeTruthy();
    await idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(touch).not.toHaveBeenCalled();
  });

  it("an accepted send stopped before any frame still reaches Recent", async () => {
    streamImpl = async function* (_id, _msg, signal, _idle, onAccepted) {
      onAccepted?.();
      await new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    };
    render(<ChatPage />);
    await send("stop me");
    fireEvent.click(await screen.findByRole("button", { name: /stop/i }));
    await waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
    expect(touch.mock.calls[0]![0]).toMatchObject({ id: "sess-1" });
  });

  it("an accepted send dropped before any frame still reaches Recent", async () => {
    streamImpl = async function* (_id, _msg, _signal, _idle, onAccepted) {
      onAccepted?.();
    };
    render(<ChatPage />);
    await send("dropped");
    await waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
  });
});
