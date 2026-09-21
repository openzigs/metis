/**
 * #1367 — the CLIENT half: a conversation must survive a page reload.
 *
 * The server half (snapshot written on every completed turn) is covered in
 * `server/tests/ai-routes.test.ts`. This covers what the browser does with it:
 * remember which session is on screen, and rehydrate it instead of creating a
 * fresh one — the create-then-discard behaviour that made a reload destroy the
 * thread.
 *
 * Falsifiable: on `main` none of `resumeChatSession`, `storeActiveSessionId` or
 * `loadActiveSessionId` existed, so every import below fails to resolve.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { resumeChatSession, storeActiveSessionId, loadActiveSessionId } =
  await import("./ai-client");

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

const SNAPSHOT_MESSAGES = [
  { role: "system", content: "you are a helpful assistant" },
  { role: "user", content: "which jobs drive reconciliation?" },
  { role: "assistant", content: "Two Quartz jobs." },
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

describe("resumeChatSession (#1367)", () => {
  it("rehydrates the transcript from the snapshot — create, reload, resume", async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/resume")) return { snapshot: { v: 1, messages: SNAPSHOT_MESSAGES } };
      return { session: SESSION };
    });

    // "Reload": the page comes back up holding only the stored id.
    storeActiveSessionId(SESSION.id);
    const restored = await resumeChatSession(loadActiveSessionId()!);

    expect(restored).not.toBeNull();
    expect(restored!.session.id).toBe("sess_1");
    expect(restored!.messages).toEqual([
      { role: "user", content: "which jobs drive reconciliation?" },
      { role: "assistant", content: "Two Quartz jobs." },
    ]);
  });

  it("drops system messages so internal prompt scaffolding never renders", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/resume")
        ? { snapshot: { v: 1, messages: SNAPSHOT_MESSAGES } }
        : { session: SESSION },
    );
    const restored = await resumeChatSession("sess_1");
    expect(restored!.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("POSTs to the resume endpoint with the id encoded", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/resume") ? { snapshot: null } : { session: SESSION },
    );
    await resumeChatSession("a b/c");
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/a%20b%2Fc/resume", { method: "POST" });
  });

  it("returns null when the 24-hour window has expired, so the caller creates a new session", async () => {
    apiFetch.mockRejectedValue(new Error("Session has expired and cannot be resumed"));
    expect(await resumeChatSession("sess_old")).toBeNull();
  });

  it("returns null for a stale id left over from another environment", async () => {
    apiFetch.mockRejectedValue(new Error("Session not found"));
    expect(await resumeChatSession("sess_gone")).toBeNull();
  });

  it("resumes a session that has no snapshot yet as an empty transcript", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/resume") ? { snapshot: null } : { session: SESSION },
    );
    const restored = await resumeChatSession("sess_1");
    expect(restored!.messages).toEqual([]);
    expect(restored!.session.id).toBe("sess_1");
  });
});
