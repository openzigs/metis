/**
 * Epic #475 (Phase 4, #487) — @mention autocomplete (@AI), presence, typing.
 *
 * Covers: the MentionInput `@AI` synthetic-suggestion extension + keyboard
 * accessibility (preserved from MentionInput), PresenceAvatars wired for the
 * discussion artifact, and the new TypingIndicator component.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/socket-client", () => ({ useSocket: vi.fn() }));

// MentionInput user search → apiFetch. Stub it so we control the user hits.
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  streamFetch: vi.fn(),
  setOnRefreshFailure: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { useSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api-client";
import { MentionInput } from "@/components/comments/MentionInput";
import { AI_MENTION_SUGGESTION } from "@/components/chat/discussion-composer";
import { TypingIndicator, typingLabel } from "@/components/chat/typing-indicator";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";

const useSocketMock = useSocket as ReturnType<typeof vi.fn>;
const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

// ---- MentionInput @AI extension --------------------------------------------

describe("MentionInput @AI extension (#487)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  function ControlledMention(props: { extra?: typeof AI_MENTION_SUGGESTION }) {
    const Wrapper = makeWrapper({});
    function Inner() {
      const [val, setVal] = useState("");
      return (
        <MentionInput
          value={val}
          onChange={setVal}
          ariaLabel="Message"
          extraSuggestions={props.extra ? [props.extra] : []}
        />
      );
    }
    return render(
      <Wrapper>
        <Inner />
      </Wrapper>,
    );
  }

  it("offers @AI on a bare @ (no user-search prefix needed)", async () => {
    const user = userEvent.setup();
    ControlledMention({ extra: AI_MENTION_SUGGESTION });
    await user.type(screen.getByLabelText("Message"), "@");
    expect(await screen.findByRole("option", { name: /@AI/ })).toBeInTheDocument();
  });

  it("inserts @AI when selected", async () => {
    const user = userEvent.setup();
    ControlledMention({ extra: AI_MENTION_SUGGESTION });
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    await user.type(box, "hey @");
    const option = await screen.findByRole("option", { name: /@AI/ });
    await user.click(option);
    await waitFor(() => expect(box.value).toContain("@AI "));
  });

  it("filters @AI out when the prefix does not match", async () => {
    apiFetchMock.mockResolvedValue([]);
    const user = userEvent.setup();
    ControlledMention({ extra: AI_MENTION_SUGGESTION });
    await user.type(screen.getByLabelText("Message"), "@zzz");
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /@AI/ })).not.toBeInTheDocument(),
    );
  });

  it("keeps @AI navigable + selectable by keyboard (Enter)", async () => {
    const user = userEvent.setup();
    ControlledMention({ extra: AI_MENTION_SUGGESTION });
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    await user.type(box, "@a");
    await screen.findByRole("option", { name: /@AI/ });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(box.value).toContain("@AI "));
  });

  it("merges @AI above real user hits (de-duped)", async () => {
    apiFetchMock.mockResolvedValue([{ id: "u9", username: "aisha", displayName: "Aisha" }]);
    const user = userEvent.setup();
    ControlledMention({ extra: AI_MENTION_SUGGESTION });
    await user.type(screen.getByLabelText("Message"), "@ai");
    const options = await screen.findAllByRole("option");
    // @AI first, then the user "aisha".
    expect(options[0]).toHaveTextContent("@AI");
    expect(options.some((o) => o.textContent?.includes("aisha"))).toBe(true);
  });
});

// ---- PresenceAvatars for a discussion --------------------------------------

describe("PresenceAvatars for a discussion (#487)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("joins the discussion presence room with artifactType=discussion", () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    useSocketMock.mockReturnValue(socket);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PresenceAvatars artifactType="discussion" artifactId="d1" />
      </Wrapper>,
    );
    expect(socket.emit).toHaveBeenCalledWith("presence:join", {
      artifactType: "discussion",
      artifactId: "d1",
    });
  });

  it("renders avatars on a presence:update for the discussion room", async () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    useSocketMock.mockReturnValue(socket);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PresenceAvatars artifactType="discussion" artifactId="d1" />
      </Wrapper>,
    );
    const handler = socket.on.mock.calls.find((c) => c[0] === "presence:update")?.[1] as (
      u: unknown,
    ) => void;
    handler({
      room: "presence:discussion:d1",
      users: [{ userId: "u1", username: "alice" }],
      ts: Date.now(),
    });
    expect(await screen.findByLabelText(/1 user\(s\) viewing/i)).toBeInTheDocument();
  });
});

// ---- TypingIndicator -------------------------------------------------------

describe("typingLabel", () => {
  it("formats one, two, and many typers", () => {
    expect(typingLabel([])).toBe("");
    expect(typingLabel(["Al"])).toBe("Al is typing…");
    expect(typingLabel(["Al", "Bo"])).toBe("Al and Bo are typing…");
    expect(typingLabel(["Al", "Bo", "Cy", "Di"])).toBe("Al, Bo and 2 more are typing…");
  });
});

describe("TypingIndicator (#487)", () => {
  let socket: {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    useSocketMock.mockReturnValue(socket);
  });

  function typingHandler(): (u: unknown) => void {
    return socket.on.mock.calls.find((c) => c[0] === "typing:update")?.[1] as (u: unknown) => void;
  }

  function renderIndicator(props: Partial<Parameters<typeof TypingIndicator>[0]> = {}) {
    return render(<TypingIndicator threadId="t1" {...props} />);
  }

  it("renders nothing when no one is typing", () => {
    const { container } = renderIndicator();
    expect(container.firstChild).toBeNull();
  });

  it("shows a peer who is typing in this thread", async () => {
    renderIndicator();
    typingHandler()({ threadId: "t1", userId: "u2", username: "bob", isTyping: true, ts: 1 });
    expect(await screen.findByText(/bob is typing/i)).toBeInTheDocument();
  });

  it("renders the typing-indicator element on a remote typing:update (#513)", async () => {
    // #513 — confirm the indicator binds to `typing:update` and the visible
    // element (not just the label text) appears for a second participant.
    renderIndicator({ currentUserId: "me" });
    expect(typingHandler()).toBeTypeOf("function");
    typingHandler()({ threadId: "t1", userId: "u2", username: "bob", isTyping: true, ts: 1 });
    expect(await screen.findByTestId("typing-indicator")).toBeInTheDocument();
  });

  it("ignores typing for a different thread", async () => {
    renderIndicator();
    typingHandler()({ threadId: "other", userId: "u2", username: "bob", isTyping: true, ts: 1 });
    await waitFor(() => expect(screen.queryByTestId("typing-indicator")).not.toBeInTheDocument());
  });

  it("never shows the current user's own typing", async () => {
    renderIndicator({ currentUserId: "me" });
    typingHandler()({ threadId: "t1", userId: "me", username: "Me", isTyping: true, ts: 1 });
    await waitFor(() => expect(screen.queryByTestId("typing-indicator")).not.toBeInTheDocument());
  });

  it("clears when the peer sends typing:stop", async () => {
    renderIndicator();
    const handler = typingHandler();
    handler({ threadId: "t1", userId: "u2", username: "bob", isTyping: true, ts: 1 });
    expect(await screen.findByText(/bob is typing/i)).toBeInTheDocument();
    handler({ threadId: "t1", userId: "u2", username: "bob", isTyping: false, ts: 2 });
    await waitFor(() => expect(screen.queryByText(/bob is typing/i)).not.toBeInTheDocument());
  });

  it("auto-clears a stale typing after the timeout", async () => {
    vi.useFakeTimers();
    try {
      render(<TypingIndicator threadId="t1" staleAfterMs={1000} />);
      act(() => {
        typingHandler()({ threadId: "t1", userId: "u2", username: "bob", isTyping: true, ts: 1 });
      });
      expect(screen.getByText(/bob is typing/i)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(screen.queryByText(/bob is typing/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aggregates two peers typing at once", async () => {
    renderIndicator();
    const handler = typingHandler();
    handler({ threadId: "t1", userId: "u2", username: "bob", isTyping: true, ts: 1 });
    handler({ threadId: "t1", userId: "u3", username: "cara", isTyping: true, ts: 2 });
    expect(await screen.findByText(/bob and cara are typing/i)).toBeInTheDocument();
  });

  it("unsubscribes the typing handler on unmount", () => {
    const { unmount } = renderIndicator();
    unmount();
    expect(socket.off).toHaveBeenCalledWith("typing:update", expect.any(Function));
  });
});
