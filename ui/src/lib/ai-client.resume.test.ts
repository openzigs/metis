/**
 * #1367 / #139 — a conversation survives a reload, and what comes back is the
 * SERVER transcript, not a client snapshot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TranscriptMessageDto } from "@metis/shared";

const apiFetch = vi.fn();

vi.mock("./api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  streamFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const {
  resumeChatSession,
  storeActiveSessionId,
  loadActiveSessionId,
  transcriptToDisplay,
  getTranscript,
  getTranscriptSince,
  lastHeldOrdinal,
  mergeTranscriptDelta,
  forkChatSession,
} = await import("./ai-client");

const SESSION = {
  id: "sess_1",
  title: "New Chat",
  provider: "offline-stub",
  model: "stub",
  policy: { low: "auto", medium: "prompt-once", high: "always-prompt" },
  status: "active",
  projectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function row(p: Partial<TranscriptMessageDto>): TranscriptMessageDto {
  return {
    id: `m${p.ordinal}`,
    ordinal: 1,
    role: "user",
    kind: "message",
    parts: [],
    tokens: { estimated: 1, input: null, output: null, cacheRead: null, cacheWrite: null },
    provider: null,
    model: null,
    finishReason: null,
    compactedAt: null,
    compactedIntoId: null,
    summaryOf: null,
    incomplete: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}
const text = (t: string) => [{ type: "text" as const, text: t }];

const TRANSCRIPT: TranscriptMessageDto[] = [
  row({
    ordinal: 1,
    role: "user",
    parts: text("which jobs drive reconciliation?"),
    compactedAt: "2026-01-02T00:00:00.000Z",
  }),
  row({
    ordinal: 2,
    role: "assistant",
    parts: [
      { type: "tool_call", id: "c1", name: "search", args: {} },
      { type: "tool_result", toolCallId: "c1", name: "search", text: "r" },
      ...text("Two Quartz jobs."),
    ],
  }),
  row({
    ordinal: 3,
    role: "system",
    kind: "summary",
    parts: text("S"),
    summaryOf: { fromOrdinal: 1, toOrdinal: 1, messageCount: 1 },
  }),
  row({
    ordinal: 4,
    role: "assistant",
    parts: text("cut"),
    incomplete: { code: "ABORTED", message: "stopped" },
  }),
];

beforeEach(() => {
  apiFetch.mockReset();
  window.localStorage.clear();
});

describe("active session id (#1367)", () => {
  it("round-trips the session the chat page is showing", () => {
    expect(loadActiveSessionId()).toBeNull();
    storeActiveSessionId("sess_1");
    expect(loadActiveSessionId()).toBe("sess_1");
  });

  it("clears the stored id when passed null, so 'New chat' really starts fresh", () => {
    storeActiveSessionId("sess_1");
    storeActiveSessionId(null);
    expect(loadActiveSessionId()).toBeNull();
  });
});

describe("transcriptToDisplay (#136)", () => {
  it("keeps ordinals, flags compacted rows, renders summaries and incomplete replies", () => {
    expect(transcriptToDisplay(TRANSCRIPT)).toEqual([
      { role: "user", content: "which jobs drive reconciliation?", ordinal: 1, compacted: true },
      {
        role: "assistant",
        content: "Two Quartz jobs.",
        ordinal: 2,
        compacted: false,
        tools: ["search"],
        // #142 — each call with how it was decided (none recorded ⇒ it ran).
        toolCalls: [
          { id: "c1", name: "search", isError: false, executed: true, resultPreview: "r" },
        ],
      },
      {
        role: "summary",
        content: "S",
        ordinal: 3,
        compacted: false,
        summaryOf: { fromOrdinal: 1, toOrdinal: 1, messageCount: 1 },
      },
      { role: "assistant", content: "cut", ordinal: 4, compacted: false, incomplete: "stopped" },
    ]);
  });

  it("drops non-summary system rows so prompt scaffolding never renders", () => {
    expect(transcriptToDisplay([row({ role: "system", parts: text("sys") })])).toEqual([]);
  });
});

describe("resumeChatSession (#1367, #139)", () => {
  it("rehydrates from the server transcript — create, reload, resume", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/resume"))
        return { session: { id: "sess_1" }, messages: TRANSCRIPT.slice(0, 2) };
      return { session: SESSION };
    });
    storeActiveSessionId(SESSION.id);
    const restored = await resumeChatSession(loadActiveSessionId()!);
    expect(restored!.session.id).toBe("sess_1");
    expect(restored!.messages.map((m) => [m.ordinal, m.role, m.content])).toEqual([
      [1, "user", "which jobs drive reconciliation?"],
      [2, "assistant", "Two Quartz jobs."],
    ]);
  });

  it("POSTs to the resume endpoint with the id encoded", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/resume") ? { messages: [] } : { session: SESSION },
    );
    await resumeChatSession("a b/c");
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/a%20b%2Fc/resume", { method: "POST" });
  });

  it("returns null when the session expired or is unknown, so the caller creates a new one", async () => {
    apiFetch.mockRejectedValue(new Error("Session has expired and cannot be resumed"));
    expect(await resumeChatSession("sess_old")).toBeNull();
  });

  it("a session with no turns resumes as an empty transcript", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/resume") ? { messages: [] } : { session: SESSION },
    );
    expect((await resumeChatSession("sess_1"))!.messages).toEqual([]);
  });
});

// #245 — resume returns one bounded page; the client follows `hasMore` through
// the paged read so a long conversation still comes back whole.
describe("resumeChatSession — a transcript longer than one page (#245)", () => {
  const PAGE = 500;
  const rows = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      row({
        ordinal: from + i,
        role: (from + i) % 2 === 1 ? "user" : "assistant",
        parts: text(`r${from + i}`),
      }),
    );

  it("ends with every row, in order, when resume says there is more", async () => {
    const total = PAGE * 2 + 7;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/resume")) {
        return {
          session: { id: "sess_1", readOnlyReason: null },
          messages: rows(1, PAGE),
          hasMore: true,
          nextAfterOrdinal: PAGE,
        };
      }
      const m = /afterOrdinal=(\d+)/.exec(path);
      if (m) {
        const after = Number(m[1]);
        const end = Math.min(after + PAGE, total);
        return {
          sessionId: "sess_1",
          messages: rows(after + 1, end),
          compactionUpdates: [],
          hasMore: end < total,
          nextAfterOrdinal: end,
        };
      }
      return { session: SESSION };
    });
    const restored = await resumeChatSession("sess_1");
    expect(restored!.messages.map((m) => m.ordinal)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    expect(restored!.messages.at(-1)!.content).toBe(`r${total}`);
    expect(apiFetch.mock.calls.map((c) => c[0]).filter((p) => String(p).includes("?"))).toEqual([
      `/ai/sessions/sess_1/messages?afterOrdinal=${PAGE}`,
      `/ai/sessions/sess_1/messages?afterOrdinal=${PAGE * 2}`,
    ]);
  });

  it("applies a later page's compaction to rows the first page returned", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/resume")) {
        return { session: { id: "s" }, messages: rows(1, 2), hasMore: true, nextAfterOrdinal: 2 };
      }
      if (path.includes("afterOrdinal=2")) {
        return {
          sessionId: "s",
          messages: [row({ ordinal: 3, role: "system", kind: "summary", parts: text("S") })],
          compactionUpdates: [
            { ordinal: 1, compactedAt: "2026-01-02T00:00:00.000Z", compactedIntoId: "m3" },
          ],
          hasMore: false,
          nextAfterOrdinal: 3,
        };
      }
      return { session: SESSION };
    });
    const restored = await resumeChatSession("s");
    expect(restored!.messages.map((m) => [m.ordinal, m.role, m.compacted])).toEqual([
      [1, "user", true],
      [2, "assistant", false],
      [3, "summary", false],
    ]);
  });

  it("reads nothing more when resume returned the whole transcript", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/resume")
        ? { messages: rows(1, 2), hasMore: false, nextAfterOrdinal: 2 }
        : { session: SESSION },
    );
    expect((await resumeChatSession("s"))!.messages).toHaveLength(2);
    expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("/messages"))).toBe(false);
  });
});

describe("getTranscript / forkChatSession", () => {
  it("reads the transcript with the id encoded", async () => {
    apiFetch.mockResolvedValue({
      sessionId: "x",
      messages: TRANSCRIPT.slice(0, 1),
      compactionUpdates: [],
      hasMore: false,
      nextAfterOrdinal: 1,
    });
    const rows = await getTranscript("a/b");
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/a%2Fb/messages?afterOrdinal=0");
    expect(rows[0]!.ordinal).toBe(1);
  });

  // #212 — a paged read is followed to the end; a page that claims more but
  // does not advance is an error, never a silently short transcript.
  it("follows every page until the server says there is no more", async () => {
    const page = (messages: TranscriptMessageDto[], hasMore: boolean, next: number) => ({
      sessionId: "s",
      messages,
      compactionUpdates: [],
      hasMore,
      nextAfterOrdinal: next,
    });
    apiFetch
      .mockResolvedValueOnce(
        page([row({ ordinal: 3, parts: [{ type: "text", text: "c" }] })], true, 3),
      )
      .mockResolvedValueOnce(
        page(
          [row({ ordinal: 4, role: "assistant", parts: [{ type: "text", text: "d" }] })],
          false,
          4,
        ),
      );
    const delta = await getTranscriptSince("s", 2);
    expect(apiFetch.mock.calls.map((c) => c[0])).toEqual([
      "/ai/sessions/s/messages?afterOrdinal=2",
      "/ai/sessions/s/messages?afterOrdinal=3",
    ]);
    expect(delta.afterOrdinal).toBe(2);
    expect(delta.rows.map((r) => r.ordinal)).toEqual([3, 4]);

    apiFetch.mockReset();
    apiFetch.mockResolvedValue(page([], true, 2));
    await expect(getTranscriptSince("s", 2)).rejects.toThrow(/could not be read in full/);
  });

  it("carries compaction updates for rows the reader already holds", async () => {
    apiFetch.mockResolvedValue({
      sessionId: "s",
      messages: [row({ ordinal: 7, role: "system", kind: "summary", parts: [] })],
      compactionUpdates: [
        { ordinal: 1, compactedAt: "2026-01-02T00:00:00.000Z", compactedIntoId: "m7" },
      ],
      hasMore: false,
      nextAfterOrdinal: 7,
    });
    const delta = await getTranscriptSince("s", 6);
    expect(delta.compactionUpdates).toEqual([{ ordinal: 1, compacted: true }]);
    expect(delta.rows.map((r) => r.role)).toEqual(["summary"]);
  });
});

describe("mergeTranscriptDelta / lastHeldOrdinal (#212)", () => {
  type Held = { id: string; ordinal?: number; compacted?: boolean; content: string };
  const wrap = (m: { ordinal: number; compacted: boolean; content: string }): Held => ({
    id: `o${m.ordinal}`,
    ordinal: m.ordinal,
    compacted: m.compacted,
    content: m.content,
  });

  it("the last held ordinal ignores optimistic rows", () => {
    expect(lastHeldOrdinal([])).toBe(0);
    expect(lastHeldOrdinal([{ ordinal: 1 }, { ordinal: 4 }, {}, { ordinal: 2 }])).toBe(4);
  });

  it("keeps held rows, replaces the optimistic ones, appends new rows and applies compaction", () => {
    const held: Held[] = [
      { id: "o1", ordinal: 1, compacted: false, content: "q1" },
      { id: "o2", ordinal: 2, compacted: false, content: "a1" },
      { id: "tmp-user", content: "q2" },
      { id: "tmp-assistant", content: "a2 (streamed)" },
    ];
    const merged = mergeTranscriptDelta(
      held,
      {
        afterOrdinal: 2,
        rows: [
          { role: "user", content: "q2", ordinal: 3, compacted: false },
          { role: "assistant", content: "a2", ordinal: 4, compacted: false },
        ],
        compactionUpdates: [{ ordinal: 1, compacted: true }],
      },
      wrap,
    );
    expect(merged.map((m) => [m.id, m.content, m.compacted])).toEqual([
      ["o1", "q1", true],
      ["o2", "a1", false],
      ["o3", "q2", false],
      ["o4", "a2", false],
    ]);
    // The held array itself is not mutated.
    expect(held[0]!.compacted).toBe(false);
  });
});

describe("forkChatSession", () => {
  it("forks from an ordinal", async () => {
    apiFetch.mockResolvedValue({ session: { id: "fork" }, copiedMessages: 2 });
    const res = await forkChatSession("s 1", 2);
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/s%201/fork", {
      method: "POST",
      body: { fromOrdinal: 2 },
    });
    expect(res.session.id).toBe("fork");
  });
});
