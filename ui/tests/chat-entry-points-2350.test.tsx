/**
 * #2350 — the pieces behind "Ask about this" and "Advanced": the link each
 * entry point carries, the server read and its states, the words chat shows,
 * and the per-user Advanced choice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { parseChatSubjectParam, type ChatSubjectDto } from "@metis/shared";
import { AuthProvider } from "@/lib/auth-context";
import type { AuthUser } from "@/lib/auth-types";
import { TEST_USER, makeWrapper } from "./test-utils";
import { ApiError, apiFetch } from "@/lib/api-client";
import {
  chatAboutHref,
  loadSessionSubject,
  SESSION_SUBJECTS_MAX,
  storeSessionSubject,
  subjectLabel,
  subjectPrompt,
} from "@/lib/chat-subject";
import { AskAboutThis } from "@/components/chat/ask-about-this";
import {
  ChatSubjectNotice,
  SUBJECT_FAILED,
  SUBJECT_REFUSED,
  useChatSubject,
} from "@/components/chat/chat-subject";
import {
  AdvancedToggle,
  assistantInPlainWords,
  loadAdvanced,
  storeAdvanced,
  useChatAdvanced,
} from "@/components/chat/chat-advanced";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});
const fetchMock = vi.mocked(apiFetch);

const PROJECT: ChatSubjectDto = {
  kind: "project",
  id: "p1",
  projectId: "p1",
  projectName: "Alpha",
  title: "Alpha",
  changeRequestTitle: null,
};
const REQ: ChatSubjectDto = {
  kind: "requirement",
  id: "r1",
  projectId: "p1",
  projectName: "Alpha",
  title: "Pay by card",
  changeRequestTitle: "Checkout v2",
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("chatAboutHref", () => {
  it("carries the kind and the id as one about value the chat can parse back", () => {
    const href = chatAboutHref("requirement", "r/1");
    expect(href).toBe("/chat?about=requirement%3Ar%252F1");
    const about = new URL(href, "http://x").searchParams.get("about");
    expect(parseChatSubjectParam(about)).toEqual({ kind: "requirement", id: "r/1" });
  });
});

describe("subjectLabel / subjectPrompt", () => {
  it("names each kind in words", () => {
    expect(subjectLabel(PROJECT)).toBe("the project “Alpha”");
    expect(subjectLabel({ ...PROJECT, kind: "change-request", title: "Checkout v2" })).toBe(
      "the change request “Checkout v2”",
    );
    expect(subjectLabel(REQ)).toBe(
      "the requirement “Pay by card” in the change request “Checkout v2”",
    );
    expect(subjectLabel({ ...REQ, changeRequestTitle: null })).toBe(
      "the requirement “Pay by card”",
    );
  });

  it("opens the composer on a question about a change request or requirement, not a project", () => {
    expect(subjectPrompt(PROJECT)).toBe("");
    expect(subjectPrompt({ ...PROJECT, kind: "change-request", title: "Checkout v2" })).toBe(
      "What does the change request “Checkout v2” ask for, and what would it affect?",
    );
    expect(subjectPrompt(REQ)).toBe(
      "Explain the requirement “Pay by card” in the change request “Checkout v2”: what it asks for, and how the system handles it today.",
    );
  });
});

describe("<AskAboutThis />", () => {
  it.each([
    ["project", "Ask about this project in chat"],
    ["change-request", "Ask about this change request in chat"],
    ["requirement", "Ask about this requirement in chat"],
  ] as const)("links a %s into chat", (kind, name) => {
    render(<AskAboutThis kind={kind} id="x1" />);
    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", chatAboutHref(kind, "x1"));
    expect(link).toHaveTextContent("Ask about this");
  });

  it("names the item when given its title", () => {
    render(<AskAboutThis kind="requirement" id="r1" title="Pay by card" />);
    expect(screen.getByRole("link", { name: "Ask about Pay by card in chat" })).toBeInTheDocument();
  });
});

describe("the item each chat is about (PR #2428 review)", () => {
  it("is remembered per session, and nothing for an unknown one", () => {
    storeSessionSubject("s1", REQ);
    storeSessionSubject("s2", PROJECT);
    expect(loadSessionSubject("s1")).toEqual(REQ);
    expect(loadSessionSubject("s2")).toEqual(PROJECT);
    expect(loadSessionSubject("s3")).toBeNull();
  });

  it(`keeps the newest ${SESSION_SUBJECTS_MAX}, re-storing one makes it newest`, () => {
    for (let i = 0; i < SESSION_SUBJECTS_MAX; i++) storeSessionSubject(`s${i}`, PROJECT);
    storeSessionSubject("s0", REQ);
    storeSessionSubject("new", PROJECT);
    expect(loadSessionSubject("s0")).toEqual(REQ);
    expect(loadSessionSubject("s1")).toBeNull();
    expect(loadSessionSubject("new")).toEqual(PROJECT);
  });

  it("ignores a store that is not JSON, or an entry that is not an item", () => {
    window.localStorage.setItem("metis.chat.sessionSubjects", "{not json");
    expect(loadSessionSubject("s1")).toBeNull();
    window.localStorage.setItem(
      "metis.chat.sessionSubjects",
      JSON.stringify({ s1: { kind: "workspace", id: "w" }, s2: REQ }),
    );
    expect(loadSessionSubject("s1")).toBeNull();
    expect(loadSessionSubject("s2")).toEqual(REQ);
  });
});

describe("useChatSubject", () => {
  it("is 'none' with no about, and asks nothing", () => {
    const { result } = renderHook(() => useChatSubject(null));
    expect(result.current).toEqual({ status: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the server, encoded, and is ready with its answer", async () => {
    fetchMock.mockResolvedValue(REQ);
    const { result } = renderHook(() => useChatSubject({ kind: "requirement", id: "r/1" }));
    expect(result.current).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current).toEqual({ status: "ready", subject: REQ }));
    expect(fetchMock).toHaveBeenCalledWith("/ai/chat-subjects/requirement/r%2F1");
  });

  it.each([400, 403, 404])("is 'refused' when the server refuses (%i)", async (status) => {
    fetchMock.mockRejectedValue(new ApiError(status, "no"));
    const { result } = renderHook(() => useChatSubject({ kind: "project", id: "p9" }));
    await waitFor(() => expect(result.current).toEqual({ status: "refused" }));
  });

  // PR #2428 review — a busy server or a dropped connection is not a refusal:
  // it says so, and can be tried again.
  it.each([
    ["a 429", new ApiError(429, "slow down")],
    ["a 5xx", new ApiError(503, "unavailable")],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("is 'failed', with a retry, on %s", async (_label, err) => {
    fetchMock.mockRejectedValueOnce(err);
    const { result } = renderHook(() => useChatSubject({ kind: "project", id: "p1" }));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    fetchMock.mockResolvedValueOnce(PROJECT);
    const state = result.current;
    if (state.status !== "failed") throw new Error("unreachable");
    act(() => state.retry());
    expect(result.current).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current).toEqual({ status: "ready", subject: PROJECT }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never shows the previous item's answer for a new one", async () => {
    let release: (v: ChatSubjectDto) => void = () => undefined;
    fetchMock.mockResolvedValueOnce(PROJECT);
    fetchMock.mockImplementationOnce(() => new Promise((r) => (release = r as typeof release)));
    const { result, rerender } = renderHook(
      ({ about }: { about: { kind: "project" | "requirement"; id: string } }) =>
        useChatSubject(about),
      { initialProps: { about: { kind: "project", id: "p1" } } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ about: { kind: "requirement", id: "r1" } });
    expect(result.current).toEqual({ status: "loading" });
    await act(async () => release(REQ));
    expect(result.current).toEqual({ status: "ready", subject: REQ });
  });
});

describe("<ChatSubjectNotice />", () => {
  it("says what the chat is about while in the item's scope", () => {
    render(<ChatSubjectNotice state={{ status: "ready", subject: REQ }} inScope />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Asking about the requirement “Pay by card” in the change request “Checkout v2” in Alpha. This chat searches Alpha; change the scope with the project selector.",
    );
  });

  it("does not repeat the project for a project", () => {
    render(<ChatSubjectNotice state={{ status: "ready", subject: PROJECT }} inScope />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Asking about the project “Alpha”. This chat searches Alpha;",
    );
  });

  it("shows nothing while loading, with none, or once the scope moved on", () => {
    const { container, rerender } = render(
      <ChatSubjectNotice state={{ status: "loading" }} inScope={false} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<ChatSubjectNotice state={{ status: "none" }} inScope={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ChatSubjectNotice state={{ status: "ready", subject: REQ }} inScope={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reports a refusal as an alert", () => {
    render(<ChatSubjectNotice state={{ status: "refused" }} inScope={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(SUBJECT_REFUSED);
  });

  it("reports a failed read as one, not a refusal, and tries again on request", () => {
    const retry = vi.fn();
    render(<ChatSubjectNotice state={{ status: "failed", retry }} inScope={false} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(SUBJECT_FAILED);
    expect(alert).not.toHaveTextContent("access");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders a title holding markup as text", () => {
    const evil = { ...PROJECT, title: "<img src=x onerror=alert(1)>", projectName: "<b>x</b>" };
    const { container } = render(
      <ChatSubjectNotice state={{ status: "ready", subject: evil }} inScope />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});

function withUser(user: AuthUser | null) {
  if (user === null) return makeWrapper({ withAuth: false });
  const Base = makeWrapper({ withAuth: false });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <Base>
        <AuthProvider initialUser={user}>{children}</AuthProvider>
      </Base>
    );
  };
}

describe("Advanced (#2350)", () => {
  const ANALYST: AuthUser = { ...TEST_USER, id: "u-a", role: "developer" };

  it("stores the choice per user, off when never set or cleared", () => {
    expect(loadAdvanced("u-a")).toBe(false);
    storeAdvanced("u-a", true);
    expect(loadAdvanced("u-a")).toBe(true);
    expect(loadAdvanced("u-b")).toBe(false);
    storeAdvanced("u-a", false);
    expect(loadAdvanced("u-a")).toBe(false);
  });

  it("is off by default for a non-admin, and remembered once set", async () => {
    const { result } = renderHook(() => useChatAdvanced(), { wrapper: withUser(ANALYST) });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current).toMatchObject({
      toggleable: true,
      advanced: false,
      showControls: false,
    });
    act(() => result.current.setAdvanced(true));
    expect(result.current).toMatchObject({ advanced: true, showControls: true });
    expect(loadAdvanced("u-a")).toBe(true);
  });

  it("reads a stored choice back for that user", async () => {
    storeAdvanced("u-a", true);
    const { result } = renderHook(() => useChatAdvanced(), { wrapper: withUser(ANALYST) });
    await waitFor(() => expect(result.current.advanced).toBe(true));
    expect(result.current.showControls).toBe(true);
  });

  it("always shows an admin the controls, with no toggle, and ignores a set", async () => {
    const { result } = renderHook(() => useChatAdvanced(), { wrapper: withUser(TEST_USER) });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current).toMatchObject({ toggleable: false, showControls: true });
    act(() => result.current.setAdvanced(true));
    expect(loadAdvanced(TEST_USER.id)).toBe(false);
  });

  it("shows the controls, untoggleable, with no signed-in user", async () => {
    const { result } = renderHook(() => useChatAdvanced(), { wrapper: withUser(null) });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current).toMatchObject({ toggleable: false, showControls: true });
  });

  it("the toggle is a labelled switch reporting its state", () => {
    const onChange = vi.fn();
    render(<AdvancedToggle checked={false} onChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "Advanced" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("says which assistant answers in plain words", () => {
    expect(assistantInPlainWords(null, true)).toBe(
      "Answering: the METIS assistant, with this project’s settings.",
    );
    expect(assistantInPlainWords(null, false)).toBe(
      "Answering: the METIS assistant, with the standard settings.",
    );
    expect(assistantInPlainWords({ projectId: "p1" }, false)).toBe(
      "Answering: the METIS assistant, with this project’s settings.",
    );
    expect(assistantInPlainWords({ projectId: null }, true)).toBe(
      "Answering: the METIS assistant, with the standard settings.",
    );
    expect(assistantInPlainWords({ projectId: "p1", agentRef: "custom:a" }, true)).toBe(
      "Answering: the assistant this chat was started with.",
    );
    expect(assistantInPlainWords({ projectId: "p1", agentId: "lib-1" }, true)).toBe(
      "Answering: the assistant this chat was started with.",
    );
  });
});
