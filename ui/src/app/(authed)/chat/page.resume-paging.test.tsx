/**
 * #245 — resume returns one bounded page of the transcript. The chat page must
 * still end with EVERY row of a long conversation: the client follows
 * `hasMore` through the paged read. Only the HTTP layer is substituted here, so
 * the real `resumeChatSession` → `getTranscriptSince` path runs.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptMessageDto } from "@metis/shared";

const PAGE = 500;
const TOTAL = PAGE + 3;
const apiFetch = vi.fn();

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
  loadActiveSessionId: () => "sess-long",
  storeActiveSessionId: vi.fn(),
  createSessionWithScope: vi.fn(async () => {
    throw new Error("a resumable session must not be replaced by a new one");
  }),
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
  useProjectScope: () => ({
    scope: { mode: "all", projectIds: [] },
    setScope: vi.fn(),
    hydrated: true,
  }),
}));
vi.mock("@/lib/recent-tracker", () => ({ recentTracker: { touch: vi.fn() } }));

const { default: ChatPage } = await import("./page");

function dto(ordinal: number): TranscriptMessageDto {
  return {
    id: `m${ordinal}`,
    ordinal,
    role: ordinal % 2 === 1 ? "user" : "assistant",
    kind: "message",
    parts: [{ type: "text", text: `row ${ordinal}` }],
    tokens: { estimated: 1, input: null, output: null, cacheRead: null, cacheWrite: null },
    provider: null,
    model: null,
    finishReason: null,
    compactedAt: null,
    compactedIntoId: null,
    summaryOf: null,
    incomplete: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => dto(from + i));

describe("chat page — resuming a transcript longer than one page (#245)", () => {
  it("renders every row: the resume page, then the rest by following hasMore", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/ai/sessions/sess-long/resume") {
        return {
          session: { id: "sess-long", readOnlyReason: null },
          messages: range(1, PAGE),
          hasMore: true,
          nextAfterOrdinal: PAGE,
        };
      }
      if (path === `/ai/sessions/sess-long/messages?afterOrdinal=${PAGE}`) {
        return {
          sessionId: "sess-long",
          messages: range(PAGE + 1, TOTAL),
          compactionUpdates: [],
          hasMore: false,
          nextAfterOrdinal: TOTAL,
        };
      }
      if (path === "/ai/sessions/sess-long") {
        return {
          session: {
            id: "sess-long",
            title: "t",
            provider: "offline-stub",
            model: "m",
            projectId: null,
          },
        };
      }
      return {};
    });
    render(<ChatPage />);
    await screen.findByText(`row ${TOTAL}`);
    const log = screen.getByText("row 1").closest("ul")!;
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(TOTAL));
    const items = within(log).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("row 1");
    expect(items[PAGE]!.textContent).toContain(`row ${PAGE + 1}`);
    expect(items[TOTAL - 1]!.textContent).toContain(`row ${TOTAL}`);
  });
});
