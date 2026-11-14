/**
 * #2350 — chat's history list: the caller's past conversations (from the
 * server's own per-user list), each with title, scope and date, linking to a
 * resume. Activity → Sessions is folded into it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ResumableSessionDto } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import { ChatHistory, CHAT_HISTORY_PAGE, historyScopeLabel } from "@/components/chat/chat-history";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const fetchMock = vi.mocked(apiFetch);

function row(id: string, over: Partial<ResumableSessionDto> = {}): ResumableSessionDto {
  return {
    id,
    projectId: null,
    projectName: null,
    title: `Chat ${id}`,
    model: "m",
    currentModel: null,
    currentReasoningEffort: null,
    planModeActive: false,
    status: "active",
    snapshotUpdatedAt: null,
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    scopeProjectIds: null,
    scopeWorkspaceId: null,
    ...over,
  };
}

let sessions: ResumableSessionDto[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  sessions = [];
  fetchMock.mockImplementation(async (path: string) => {
    if (path === "/workspaces") return [{ id: "ws-1", name: "Retail", slug: "retail" }];
    // As the server does: `limit` is clamped to 100, `offset` skips rows.
    const params = new URL(path, "http://x").searchParams;
    const limit = Math.min(Number(params.get("limit")), 100);
    const offset = Number(params.get("offset") ?? 0);
    return sessions.slice(offset, offset + limit);
  });
});

describe("historyScopeLabel", () => {
  it("names a project, a workspace, several products, or none", () => {
    expect(historyScopeLabel(row("a", { projectId: "p", projectName: "Alpha" }))).toBe("Alpha");
    expect(historyScopeLabel(row("a", { projectId: "p", projectName: null }))).toBe("A project");
    // #2424 — the scope picker's own words (#2351): "Whole workspace", and
    // "No product chosen" for a chat that searches nothing, never "All projects".
    expect(historyScopeLabel(row("a", { scopeWorkspaceId: "ws-1" }), () => "Retail")).toBe(
      "Whole workspace: Retail",
    );
    expect(historyScopeLabel(row("a", { scopeWorkspaceId: "ws-9" }))).toBe("Whole workspace");
    expect(historyScopeLabel(row("a", { scopeProjectIds: ["p1", "p2", "p3"] }))).toBe("3 products");
    expect(historyScopeLabel(row("a", { scopeProjectIds: ["p1"] }))).toBe("No product chosen");
    expect(historyScopeLabel(row("a"))).toBe("No product chosen");
  });
});

describe("<ChatHistory /> (#2350)", () => {
  it("lists the caller's conversations with title, scope and date, each opening it", async () => {
    sessions = [
      row("s1", { projectId: "p1", projectName: "Alpha", title: "Refund rules" }),
      row("s2", { scopeWorkspaceId: "ws-1", title: "" }),
    ];
    render(<ChatHistory activeSessionId="s1" />, { wrapper: makeWrapper({ withAuth: false }) });

    const first = await screen.findByTestId("chat-history-s1");
    expect(first).toHaveAttribute("href", "/chat?sessionId=s1");
    expect(first).toHaveAttribute("aria-current", "page");
    expect(within(first).getByText("Refund rules")).toBeInTheDocument();
    expect(first).toHaveTextContent("Alpha · 5m ago");

    const second = screen.getByTestId("chat-history-s2");
    expect(second).not.toHaveAttribute("aria-current");
    expect(second).toHaveTextContent("Untitled chat");
    await waitFor(() => expect(second).toHaveTextContent("Whole workspace: Retail"));
    // One row past the page is asked for, to know whether there are more.
    expect(fetchMock).toHaveBeenCalledWith(`/ai/sessions?limit=${CHAT_HISTORY_PAGE + 1}&offset=0`);
    expect(screen.queryByTestId("chat-history-more")).not.toBeInTheDocument();
  });

  it("encodes a session id into its link", async () => {
    sessions = [row("a/b")];
    render(<ChatHistory activeSessionId={null} />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(await screen.findByTestId("chat-history-a/b")).toHaveAttribute(
      "href",
      "/chat?sessionId=a%2Fb",
    );
  });

  it("says when there are none yet", async () => {
    render(<ChatHistory activeSessionId={null} />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(await screen.findByTestId("chat-history-empty")).toHaveTextContent(
      "No conversations yet",
    );
  });

  it("says when the list cannot be read, and tries again on request", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    render(<ChatHistory activeSessionId={null} />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    sessions = [row("s1")];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("chat-history-s1")).toBeInTheDocument();
  });

  it("shows more on request when the server has more", async () => {
    sessions = Array.from({ length: CHAT_HISTORY_PAGE + 3 }, (_, i) => row(`s${i}`));
    render(<ChatHistory activeSessionId={null} />, { wrapper: makeWrapper({ withAuth: false }) });
    await screen.findByTestId("chat-history-s0");
    expect(screen.queryByTestId(`chat-history-s${CHAT_HISTORY_PAGE}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-history-more"));
    expect(await screen.findByTestId(`chat-history-s${CHAT_HISTORY_PAGE + 2}`)).toBeInTheDocument();
    expect(screen.queryByTestId("chat-history-more")).not.toBeInTheDocument();
  });

  // PR #2428 review — a growing `limit` stopped at the server's clamp of 100.
  it("pages by offset, so Show more keeps going past 100 conversations", async () => {
    sessions = Array.from({ length: 130 }, (_, i) => row(`s${i}`));
    render(<ChatHistory activeSessionId={null} />, { wrapper: makeWrapper({ withAuth: false }) });
    await screen.findByTestId("chat-history-s0");
    for (let page = 1; page * CHAT_HISTORY_PAGE < 130; page++) {
      fireEvent.click(await screen.findByTestId("chat-history-more"));
      const lastShown = Math.min((page + 1) * CHAT_HISTORY_PAGE, 130) - 1;
      expect(await screen.findByTestId(`chat-history-s${lastShown}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link")).toHaveLength(130);
    expect(screen.queryByTestId("chat-history-more")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/ai/sessions?limit=${CHAT_HISTORY_PAGE + 1}&offset=${6 * CHAT_HISTORY_PAGE}`,
    );
  });

  it("reads the list again when the page says a turn happened", async () => {
    const spy = vi.spyOn(sdkApi, "listSessions");
    const Wrapper = makeWrapper({ withAuth: false });
    const view = render(<ChatHistory activeSessionId={null} refreshKey={0} />, {
      wrapper: Wrapper,
    });
    await screen.findByTestId("chat-history-empty");
    expect(spy).toHaveBeenCalledTimes(1);
    sessions = [row("new")];
    view.rerender(<ChatHistory activeSessionId="new" refreshKey={1} />);
    expect(await screen.findByTestId("chat-history-new")).toHaveAttribute("aria-current", "page");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
