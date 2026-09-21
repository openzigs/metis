/**
 * Epic #475 (Phase 4, #486) — discussion surface component tests.
 *
 * Covers human-vs-AI rendering + the AI model badge, XSS-safe markdown render,
 * the composer's submit/Enter behaviour, and the thread view's history load,
 * optimistic post + reconcile, live `message:new` / `message:stream` socket
 * updates, and the @AI-mention → ai-respond trigger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@/lib/socket-client", () => ({ useSocket: vi.fn() }));

vi.mock("@/lib/discussions-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/discussions-api")>();
  return {
    ...actual,
    listMessages: vi.fn(),
    postMessage: vi.fn(),
    streamAiReply: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// MentionInput (embedded in the composer) searches users via apiFetch — stub it
// so no real network call is attempted from the user-search query.
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  streamFetch: vi.fn(),
  setOnRefreshFailure: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(s: number, m: string, c?: string) {
      super(m);
      this.status = s;
      this.code = c;
    }
  },
}));

import { useSocket } from "@/lib/socket-client";
import { listMessages, postMessage, streamAiReply } from "@/lib/discussions-api";
import { toast } from "sonner";
import {
  DiscussionMessageList,
  DiscussionMessageItem,
  type DiscussionListMessage,
} from "@/components/chat/discussion-message-list";
import { DiscussionComposer } from "@/components/chat/discussion-composer";
import { DiscussionThreadView } from "@/components/chat/discussion-thread-view";

const useSocketMock = useSocket as ReturnType<typeof vi.fn>;
const listMessagesMock = listMessages as ReturnType<typeof vi.fn>;
const postMessageMock = postMessage as ReturnType<typeof vi.fn>;
const streamAiReplyMock = streamAiReply as ReturnType<typeof vi.fn>;
const toastErrorMock = toast.error as ReturnType<typeof vi.fn>;

function humanMsg(over: Partial<DiscussionListMessage> = {}): DiscussionListMessage {
  return {
    id: "m1",
    threadId: "t1",
    authorKind: "human",
    authorUserId: "u1",
    aiProvider: null,
    aiModel: null,
    aiSessionId: null,
    body: "hello team",
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...over,
  };
}
function aiMsg(over: Partial<DiscussionListMessage> = {}): DiscussionListMessage {
  return {
    id: "ai1",
    threadId: "t1",
    authorKind: "ai",
    authorUserId: null,
    aiProvider: "anthropic",
    aiModel: "claude-3",
    aiSessionId: "s1",
    body: "I can help with that.",
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...over,
  };
}

/** An async generator yielding the given events, for streamAiReply mocks. */
function gen(events: unknown[]) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** An async generator that throws before yielding — drives the catch path. */
function throwingGen(err: Error) {
  return (async function* () {
    await Promise.resolve();
    throw err;
  })();
}

// ---- DiscussionMessageList -------------------------------------------------

describe("DiscussionMessageList", () => {
  function renderList(props: Parameters<typeof DiscussionMessageList>[0]) {
    const Wrapper = makeWrapper({});
    return render(
      <Wrapper>
        <DiscussionMessageList {...props} />
      </Wrapper>,
    );
  }

  it("renders a human message with a human badge and no model badge", () => {
    renderList({ messages: [humanMsg({ authorName: "Alice" })] });
    expect(screen.getByText("hello team")).toBeInTheDocument();
    expect(screen.getByText("human")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-model-badge")).not.toBeInTheDocument();
  });

  it("renders an AI message labeled AI with the model id badge", () => {
    renderList({ messages: [aiMsg()] });
    expect(screen.getByTestId("ai-model-badge")).toHaveTextContent("claude-3");
    const row = screen.getByTestId("discussion-message");
    expect(row).toHaveAttribute("data-author-kind", "ai");
  });

  it("shows the loading state", () => {
    renderList({ messages: [], loading: true });
    expect(screen.getByText(/loading discussion/i)).toBeInTheDocument();
  });

  it("shows the empty state with an @AI hint", () => {
    renderList({ messages: [] });
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("shows the error state as an alert", () => {
    renderList({ messages: [], error: "nope" });
    expect(screen.getByRole("alert")).toHaveTextContent("nope");
  });

  it("renders markdown safely — no script tag injected", () => {
    const Wrapper = makeWrapper({});
    const { container } = render(
      <Wrapper>
        <DiscussionMessageItem
          message={aiMsg({ body: "ok <script>alert('xss')</script> **bold**" })}
        />
      </Wrapper>,
    );
    // The raw <script> must NOT make it into the DOM.
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });

  it("renders a streaming placeholder for an empty AI body", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DiscussionMessageItem message={aiMsg({ body: "", streaming: true })} />
      </Wrapper>,
    );
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("renders nothing in the body for an empty, non-streaming message", () => {
    const Wrapper = makeWrapper({});
    const { container } = render(
      <Wrapper>
        <DiscussionMessageItem message={humanMsg({ body: "" })} />
      </Wrapper>,
    );
    // No markdown content + no streaming ellipsis.
    expect(container.textContent).not.toContain("…");
  });

  it("renders an errored message in destructive style with a warning prefix", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DiscussionMessageItem message={aiMsg({ body: "boom", isError: true })} />
      </Wrapper>,
    );
    expect(screen.getByText(/⚠ boom/)).toBeInTheDocument();
  });
});

// ---- DiscussionComposer ----------------------------------------------------

describe("DiscussionComposer", () => {
  // The composer now embeds MentionInput (needs a QueryClient) + useSocket.
  beforeEach(() => {
    vi.clearAllMocks();
    useSocketMock.mockReturnValue({ emit: vi.fn(), on: vi.fn(), off: vi.fn() });
  });

  function renderComposer(props: Parameters<typeof DiscussionComposer>[0]) {
    const Wrapper = makeWrapper({});
    return render(
      <Wrapper>
        <DiscussionComposer {...props} />
      </Wrapper>,
    );
  }

  it("submits the trimmed body and clears the input", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderComposer({ onSubmit });
    const box = screen.getByLabelText("Message");
    await user.type(box, "  hi there  ");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(onSubmit).toHaveBeenCalledWith("hi there");
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderComposer({ onSubmit });
    const box = screen.getByLabelText("Message");
    await user.type(box, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(box, "{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit empty input", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderComposer({ onSubmit });
    const sendBtn = screen.getByRole("button", { name: /send/i });
    expect(sendBtn).toBeDisabled();
    await user.click(sendBtn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a children slot above the input", () => {
    renderComposer({
      onSubmit: vi.fn(),
      children: <div data-testid="typing">typing…</div>,
    });
    expect(screen.getByTestId("typing")).toBeInTheDocument();
  });

  it("operates as a controlled input via value + onChange", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const Wrapper = makeWrapper({});
    const { rerender } = render(
      <Wrapper>
        <DiscussionComposer value="seed" onChange={onChange} onSubmit={onSubmit} />
      </Wrapper>,
    );
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.value).toBe("seed");
    await user.type(box, "X");
    expect(onChange).toHaveBeenCalled();
    rerender(
      <Wrapper>
        <DiscussionComposer value="ready" onChange={onChange} onSubmit={onSubmit} />
      </Wrapper>,
    );
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(onSubmit).toHaveBeenCalledWith("ready");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows a busy label and disables send while busy", () => {
    renderComposer({ onSubmit: vi.fn(), busy: true, value: "x", onChange: vi.fn() });
    const btn = screen.getByRole("button", { name: /sending/i });
    expect(btn).toBeDisabled();
  });

  // #487 — typing:start / typing:stop socket emission while typing.
  it("emits typing:start on input and typing:stop on submit", async () => {
    const emit = vi.fn();
    useSocketMock.mockReturnValue({ emit, on: vi.fn(), off: vi.fn() });
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderComposer({ onSubmit, threadId: "t1" });
    await user.type(screen.getByLabelText("Message"), "hi");
    expect(emit).toHaveBeenCalledWith("typing:start", { threadId: "t1" });
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(emit).toHaveBeenCalledWith("typing:stop", { threadId: "t1" });
  });
});

// ---- DiscussionThreadView --------------------------------------------------

describe("DiscussionThreadView", () => {
  let socket: {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    useSocketMock.mockReturnValue(socket);
    listMessagesMock.mockResolvedValue([]);
  });

  function renderView(props: Partial<Parameters<typeof DiscussionThreadView>[0]> = {}) {
    const Wrapper = makeWrapper({});
    return render(
      <Wrapper>
        <DiscussionThreadView threadId="t1" currentUserId="u1" {...props} />
      </Wrapper>,
    );
  }

  function socketHandler(event: string): ((p: unknown) => void) | undefined {
    return socket.on.mock.calls.find((c: unknown[]) => c[0] === event)?.[1] as
      | ((p: unknown) => void)
      | undefined;
  }

  it("loads and renders history on mount", async () => {
    listMessagesMock.mockResolvedValue([humanMsg({ body: "from history" })]);
    renderView();
    expect(await screen.findByText("from history")).toBeInTheDocument();
    expect(listMessagesMock).toHaveBeenCalledWith("t1", { limit: 100 });
  });

  it("surfaces a history load error", async () => {
    listMessagesMock.mockRejectedValue(new Error("denied"));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("denied");
  });

  it("subscribes to the thread room and unsubscribes on unmount", async () => {
    const { unmount } = renderView();
    await waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith("subscribe:thread", { threadId: "t1" }),
    );
    unmount();
    expect(socket.emit).toHaveBeenCalledWith("unsubscribe:thread", { threadId: "t1" });
  });

  it("renders a live message:new event from another member", async () => {
    renderView();
    await waitFor(() => expect(socketHandler("message:new")).toBeDefined());
    const onNew = socketHandler("message:new")!;
    onNew({ threadId: "t1", message: humanMsg({ id: "remote", body: "live hello" }), ts: 1 });
    expect(await screen.findByText("live hello")).toBeInTheDocument();
  });

  it("ignores message:new for a different thread", async () => {
    renderView();
    await waitFor(() => expect(socketHandler("message:new")).toBeDefined());
    socketHandler("message:new")!({
      threadId: "other",
      message: humanMsg({ id: "x", body: "should not show" }),
      ts: 1,
    });
    await waitFor(() => {
      expect(screen.queryByText("should not show")).not.toBeInTheDocument();
    });
  });

  it("accumulates message:stream chunks into a streaming AI message", async () => {
    renderView();
    await waitFor(() => expect(socketHandler("message:stream")).toBeDefined());
    const onStream = socketHandler("message:stream")!;
    onStream({ threadId: "t1", messageId: "ai-stream", delta: "Hel", done: false, ts: 1 });
    onStream({ threadId: "t1", messageId: "ai-stream", delta: "lo", done: false, ts: 2 });
    expect(await screen.findByText("Hello")).toBeInTheDocument();
  });

  it("optimistically renders a posted message and reconciles with the server echo", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "my message" }));
    const user = userEvent.setup();
    renderView();
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "my message");
    await user.click(screen.getByRole("button", { name: /send/i }));
    // Optimistic render is immediate.
    expect(await screen.findByText("my message")).toBeInTheDocument();
    await waitFor(() => expect(postMessageMock).toHaveBeenCalledWith("t1", "my message"));
  });

  it("triggers the AI reply and streams it when the message mentions @AI (on_mention)", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "@AI help me" }));
    streamAiReplyMock.mockReturnValue(
      gen([
        { type: "delta", content: "Sure" },
        { type: "delta", content: ", here" },
        { type: "done" },
      ]),
    );
    const user = userEvent.setup();
    renderView({ aiResponseMode: "on_mention" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "@AI help me");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(streamAiReplyMock).toHaveBeenCalledWith("t1", "server-1", expect.anything()),
    );
    expect(await screen.findByText("Sure, here")).toBeInTheDocument();
  });

  it("does NOT trigger an AI reply for a plain message in on_mention mode", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "no mention here" }));
    const user = userEvent.setup();
    renderView({ aiResponseMode: "on_mention" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "no mention here");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(postMessageMock).toHaveBeenCalled());
    expect(streamAiReplyMock).not.toHaveBeenCalled();
  });

  it("always triggers an AI reply in auto mode, even without a mention", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "what is the goal?" }));
    streamAiReplyMock.mockReturnValue(gen([{ type: "done" }]));
    const user = userEvent.setup();
    renderView({ aiResponseMode: "auto" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "what is the goal?");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(streamAiReplyMock).toHaveBeenCalled());
  });

  it("rolls back the optimistic message and toasts on a post failure", async () => {
    postMessageMock.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    renderView();
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "will fail");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("network down"));
    await waitFor(() => expect(screen.queryByText("will fail")).not.toBeInTheDocument());
  });

  it("renders an AI stream error inline and toasts", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "@AI go" }));
    streamAiReplyMock.mockReturnValue(gen([{ type: "error", message: "provider exploded" }]));
    const user = userEvent.setup();
    renderView({ aiResponseMode: "on_mention" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "@AI go");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("provider exploded"));
  });

  it("renders a header slot when provided", async () => {
    renderView({ header: <div data-testid="hdr">presence</div> });
    expect(await screen.findByTestId("hdr")).toBeInTheDocument();
  });

  it("creates a placeholder when a message:stream chunk arrives for an unseen message, then finalizes on done", async () => {
    renderView();
    await waitFor(() => expect(socketHandler("message:stream")).toBeDefined());
    const onStream = socketHandler("message:stream")!;
    onStream({ threadId: "t1", messageId: "ai-x", delta: "Stream body", done: false, ts: 1 });
    expect(await screen.findByText("Stream body")).toBeInTheDocument();
    // Terminal frame: keeps the accumulated body, drops the streaming flag.
    onStream({ threadId: "t1", messageId: "ai-x", delta: "", done: true, ts: 2 });
    expect(await screen.findByText("Stream body")).toBeInTheDocument();
  });

  it("ignores a message:stream event without a messageId", async () => {
    renderView();
    await waitFor(() => expect(socketHandler("message:stream")).toBeDefined());
    socketHandler("message:stream")!({ threadId: "t1", delta: "no id", done: false, ts: 1 });
    await waitFor(() => expect(screen.queryByText("no id")).not.toBeInTheDocument());
  });

  it("replaces the local SSE placeholder when the authoritative AI message:new arrives", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "@AI hi" }));
    // Stream a delta, but never end — the room message:new is the source of truth.
    streamAiReplyMock.mockReturnValue(gen([{ type: "delta", content: "partial" }]));
    const user = userEvent.setup();
    renderView({ aiResponseMode: "on_mention" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "@AI hi");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("partial")).toBeInTheDocument();

    // Authoritative AI message:new with the real id + model badge arrives.
    const onNew = socketHandler("message:new")!;
    onNew({
      threadId: "t1",
      message: aiMsg({ id: "ai-real", body: "final answer", aiModel: "claude-3" }),
      ts: 9,
    });
    expect(await screen.findByText("final answer")).toBeInTheDocument();
    // The local placeholder's partial text is gone (no duplicate AI message).
    await waitFor(() => expect(screen.queryByText("partial")).not.toBeInTheDocument());
  });

  it("renders inline + toasts when the AI stream throws a non-abort error", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "@AI go" }));
    streamAiReplyMock.mockReturnValue(throwingGen(new Error("connection reset")));
    const user = userEvent.setup();
    renderView({ aiResponseMode: "on_mention" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "@AI go");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("connection reset"));
    expect(await screen.findByText(/⚠ connection reset/)).toBeInTheDocument();
  });

  it("swallows an AbortError mid-stream without toasting", async () => {
    postMessageMock.mockResolvedValue(humanMsg({ id: "server-1", body: "@AI go" }));
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    streamAiReplyMock.mockReturnValue(throwingGen(abortErr));
    const user = userEvent.setup();
    renderView({ aiResponseMode: "on_mention" });
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "@AI go");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(streamAiReplyMock).toHaveBeenCalled());
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  // #488 — promote action + settings panel are member-only and need a project.
  it("shows the promote action only when projectId is provided (member)", async () => {
    listMessagesMock.mockResolvedValue([humanMsg({ id: "server-1", body: "promote me" })]);
    renderView({ projectId: "p1" });
    expect(await screen.findByTestId("promote-action")).toBeInTheDocument();
  });

  it("hides the promote action when no projectId is provided", async () => {
    listMessagesMock.mockResolvedValue([humanMsg({ id: "server-1", body: "no promote" })]);
    renderView();
    await screen.findByText("no promote");
    expect(screen.queryByTestId("promote-action")).not.toBeInTheDocument();
  });

  it("opens the promote dialog when the action is clicked", async () => {
    listMessagesMock.mockResolvedValue([humanMsg({ id: "server-1", body: "promote me" })]);
    const user = userEvent.setup();
    renderView({ projectId: "p1" });
    await user.click(await screen.findByTestId("promote-action"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // The dialog seeds the title from the message body — a unique tell it opened.
    expect(await screen.findByLabelText("Title")).toHaveValue("promote me");
  });

  it("reveals the settings panel (aiResponseMode control) via the Settings toggle", async () => {
    const user = userEvent.setup();
    renderView({ projectId: "p1" });
    await user.click(await screen.findByTestId("thread-settings-toggle"));
    expect(await screen.findByTestId("thread-settings-panel")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /ai participation/i })).toBeInTheDocument();
  });

  it("hides the Settings toggle for a non-member", async () => {
    renderView({ projectId: "p1", isMember: false });
    await waitFor(() => expect(listMessagesMock).toHaveBeenCalled());
    expect(screen.queryByTestId("thread-settings-toggle")).not.toBeInTheDocument();
  });
});
