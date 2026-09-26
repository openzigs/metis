/**
 * #142/#143 — the chat page is the approve/deny endpoint's first consumer.
 *
 * A `tool_event` awaiting approval arrives on the stream; the page shows the
 * call with Approve / Deny, and a click sends the owner's answer for THAT
 * session and approval id. The old `window.confirm` decided nothing server-side
 * and aborted the whole turn on "no" — it must be gone. Events that arrive on
 * the session's socket room land in the same list.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiToolEvent } from "@metis/shared";

const decideToolApproval = vi.fn();
let releaseStream: () => void = () => undefined;
let streamEvents: unknown[] = [];

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
    getTranscript: vi.fn(async () => []),
    decideToolApproval: (...a: unknown[]) => decideToolApproval(...a),
    streamChat: async function* () {
      for (const ev of streamEvents) yield ev;
      await new Promise<void>((r) => (releaseStream = r));
      yield { type: "done" };
    },
  };
});
const socketHandlers = new Map<string, (payload: unknown) => void>();
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({
    emit: vi.fn(),
    on: (name: string, fn: (p: unknown) => void) => socketHandlers.set(name, fn),
    off: (name: string) => socketHandlers.delete(name),
  }),
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

const PROMPT: AiToolEvent = {
  type: "tool_event",
  phase: "awaiting_approval",
  sessionId: "sess-1",
  callId: "c1",
  name: "query_database",
  risk: "high",
  source: "metis",
  argsPreview: '{"sql":"select count(*) from users"}',
  approvalId: "apr_1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ts: 1,
};

beforeEach(() => {
  decideToolApproval.mockReset();
  decideToolApproval.mockResolvedValue({ approvalId: "apr_1", decision: "approve" });
  streamEvents = [];
  socketHandlers.clear();
});
afterEach(() => {
  releaseStream();
});

async function send(text: string) {
  await waitFor(() =>
    expect(screen.getByLabelText("Message")).not.toHaveProperty("disabled", true),
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("chat page — tool approvals (#142)", () => {
  it("shows the pending call and sends the owner's approval for this session", async () => {
    const confirm = vi.spyOn(window, "confirm");
    streamEvents = [
      { ...PROMPT, phase: "started", approvalId: undefined },
      PROMPT,
      // The legacy frame must not trigger a local, meaningless confirm().
      { type: "tool_call", name: "query_database", arguments: {}, risk: "high" },
    ];
    render(<ChatPage />);
    await send("how many users?");
    const approve = await screen.findByRole("button", { name: "Approve query_database" });
    expect(screen.getByText('{"sql":"select count(*) from users"}')).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() =>
      expect(decideToolApproval).toHaveBeenCalledWith("sess-1", "apr_1", "approve"),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("sends a denial too, and says so when the approval is gone", async () => {
    decideToolApproval.mockRejectedValue(new Error("404"));
    streamEvents = [PROMPT];
    render(<ChatPage />);
    await send("drop it");
    fireEvent.click(await screen.findByRole("button", { name: "Deny query_database" }));
    await waitFor(() => expect(decideToolApproval).toHaveBeenCalledWith("sess-1", "apr_1", "deny"));
    expect(await screen.findByText(/no longer pending/)).toBeTruthy();
  });

  it("a prompt from the session's socket room lands in the same list", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(socketHandlers.has("ai:tool:event")).toBe(true));
    act(() => socketHandlers.get("ai:tool:event")!(PROMPT));
    expect(await screen.findByRole("button", { name: "Approve query_database" })).toBeTruthy();
    // …and another session's event does not.
    act(() =>
      socketHandlers.get("ai:tool:event")!({
        ...PROMPT,
        sessionId: "sess-9",
        callId: "c9",
        name: "other",
      }),
    );
    expect(screen.queryByText("other")).toBeNull();
  });
});
