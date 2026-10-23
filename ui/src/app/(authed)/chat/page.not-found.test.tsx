/**
 * #1412 — a chat link (`/chat?sessionId=…`) that names a chat the server will
 * not open — deleted, in a project that was deleted, or someone else's — says
 * "Chat not found" instead of showing an empty chat as if it were new. The
 * chat last open on this device is resumed quietly, so a stale one shows
 * nothing. Only the HTTP layer is substituted: the real `resumeChatSession`
 * runs against the server's 404.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";

const apiFetch = vi.fn();
const nav = vi.hoisted(() => ({ query: "" }));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock("@/lib/ai-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-client")>()),
  loadActiveSessionId: () => "sess-stale",
  storeActiveSessionId: vi.fn(),
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

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/resume")) {
      throw new ApiError(404, "Session not found", "AI_SESSION_NOT_FOUND");
    }
    return {};
  });
});

describe("chat page — a chat that cannot be opened (#1412)", () => {
  it("a ?sessionId= link the server answers 404 shows 'Chat not found'", async () => {
    nav.query = "sessionId=sess-gone";
    render(<ChatPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Chat not found/);
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/sess-gone/resume", { method: "POST" });
  });

  it("the chat last open on this device is resumed quietly: no alert when it is gone", async () => {
    nav.query = "";
    render(<ChatPage />);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/sess-stale/resume", { method: "POST" }),
    );
    await screen.findByText("Ask a question, or start from one of these:");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
