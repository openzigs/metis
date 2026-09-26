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

describe("getTranscript / forkChatSession", () => {
  it("reads the transcript with the id encoded", async () => {
    apiFetch.mockResolvedValue({ sessionId: "x", messages: TRANSCRIPT.slice(0, 1) });
    const rows = await getTranscript("a/b");
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/a%2Fb/messages");
    expect(rows[0]!.ordinal).toBe(1);
  });

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
