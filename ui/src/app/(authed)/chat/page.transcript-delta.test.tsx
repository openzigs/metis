/**
 * #212 — after a turn, the chat page reads only what changed: the rows after
 * the last ordinal it holds, plus the compaction state of rows it already has.
 * It used to re-download the whole transcript after every turn.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTranscriptSince = vi.fn();

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
    getTranscript: vi.fn(async () => {
      throw new Error("the page must not re-read the whole transcript");
    }),
    getTranscriptSince: (...a: unknown[]) => getTranscriptSince(...a),
    streamChat: async function* () {
      yield { type: "delta", content: "streamed" };
      yield { type: "done" };
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

const turn = (ordinal: number, role: "user" | "assistant", content: string) => ({
  role,
  content,
  ordinal,
  compacted: false,
});

beforeEach(() => {
  getTranscriptSince.mockReset();
});

async function send(text: string) {
  await waitFor(() =>
    expect(screen.getByLabelText("Message")).not.toHaveProperty("disabled", true),
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("chat page — incremental transcript read (#212)", () => {
  it("asks only for rows after the last ordinal it holds, and applies compaction to held rows", async () => {
    getTranscriptSince
      .mockResolvedValueOnce({
        afterOrdinal: 0,
        rows: [turn(1, "user", "first question"), turn(2, "assistant", "first answer")],
        compactionUpdates: [],
      })
      .mockResolvedValueOnce({
        afterOrdinal: 2,
        rows: [turn(3, "user", "second question"), turn(4, "assistant", "second answer")],
        compactionUpdates: [{ ordinal: 1, compacted: true }],
      });
    render(<ChatPage />);

    await send("first question");
    await screen.findByText("first answer");
    expect(getTranscriptSince).toHaveBeenLastCalledWith("sess-1", 0);

    await send("second question");
    await screen.findByText("second answer");
    expect(getTranscriptSince).toHaveBeenLastCalledWith("sess-1", 2);

    // Every row once, in order: the held rows kept, the optimistic ones replaced.
    const log = screen.getByText("first question").closest("ul")!;
    const items = within(log).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("first question"),
      expect.stringContaining("first answer"),
      expect.stringContaining("second question"),
      expect.stringContaining("second answer"),
    ]);
    // The compaction update reached a row the page already held.
    expect(items[0]!.textContent).toContain("summarised");
    expect(items[1]!.textContent).not.toContain("summarised");
  });
});
