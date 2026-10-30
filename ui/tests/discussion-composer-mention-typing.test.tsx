/**
 * #1572 — in a discussion thread, picking a mention from the @ picker and then
 * typing raised React "Maximum update depth exceeded" in the composer and
 * scrambled the message. The composer must keep the caret after the inserted
 * mention and the text as typed, with no render loop.
 */
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/socket-client", () => ({
  closeSocket: vi.fn(),
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  streamFetch: vi.fn(),
  setOnRefreshFailure: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from "@/lib/api-client";
import { DiscussionComposer } from "@/components/chat/discussion-composer";

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
let consoleError: MockInstance<typeof console.error>;
let commits = 0;

beforeEach(() => {
  vi.clearAllMocks();
  commits = 0;
  apiFetchMock.mockResolvedValue([
    { id: "u1", username: "bob", displayName: "Bob Jones" },
    { id: "u2", username: "bobby", displayName: "Bobby Tables" },
  ]);
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => consoleError.mockRestore());

function renderComposer(queryClient?: QueryClient) {
  const Wrapper = makeWrapper(queryClient ? { queryClient } : {});
  render(
    <Wrapper>
      <Profiler id="composer" onRender={() => void (commits += 1)}>
        <DiscussionComposer onSubmit={vi.fn()} threadId="t1" projectId="p1" />
      </Profiler>
    </Wrapper>,
  );
  return screen.getByLabelText("Message") as HTMLTextAreaElement;
}

/** Insert `text` at the textarea's caret, as a keystroke does, and tell React. */
function typeAtCaret(box: HTMLTextAreaElement, text: string) {
  box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
  fireEvent.input(box);
}

function updateDepthErrors(): number {
  return consoleError.mock.calls.filter((args) =>
    args.some((a) => String(a).includes("Maximum update depth")),
  ).length;
}

function selected(): string[] {
  return screen
    .getAllByRole("option")
    .filter((o) => o.getAttribute("aria-selected") === "true")
    .map((o) => o.textContent ?? "");
}

describe("DiscussionComposer — typing after picking an @mention (#1572)", () => {
  it("keeps the text as typed when keys arrive before the page catches up", async () => {
    // The caret used to be put back after the mention by a timer. Keys typed
    // before it fired (a busy page, a fast typist) were followed by the caret
    // jumping back to just after the mention, so the rest of the message landed
    // in the middle of it: "@AI he entry_frequency ... how does time".
    const user = userEvent.setup();
    const box = renderComposer();
    await user.type(box, "@");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /@AI/ }));
    expect(box.value).toBe("@AI ");

    // Typed in the same task as the pick, where the browser puts typed text: at
    // the caret, which then follows it.
    typeAtCaret(box, "how does");
    expect(box.selectionStart).toBe(12);
    // The page catches up (any timer still pending runs now)...
    await new Promise((r) => setTimeout(r, 20));
    // ...and the user goes on typing.
    typeAtCaret(box, " the time column change");

    expect(box.value).toBe("@AI how does the time column change");
    expect(updateDepthErrors()).toBe(0);
  });

  it("keeps the caret after a user picked by keyboard mid-sentence", async () => {
    const user = userEvent.setup();
    const box = renderComposer();
    await user.type(box, "ask @bo");
    await screen.findAllByRole("option", { name: /@bob/ });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(box.value).toBe("ask @bob "));
    expect(box.selectionStart).toBe(9);

    await user.type(box, "about time", { skipClick: true });

    expect(box.value).toBe("ask @bob about time");
    expect(updateDepthErrors()).toBe(0);
  });

  it("ArrowDown moves the highlight, renders once, and Enter inserts the highlighted user", async () => {
    const user = userEvent.setup();
    const box = renderComposer();
    await user.type(box, "@bo");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(selected()).toEqual(["@bobBob Jones"]);

    // One key, one render: nothing sets state again after the commit (the
    // effect that did re-ran on every render and undid this very move).
    const before = commits;
    await user.keyboard("{ArrowDown}");
    expect(commits - before).toBe(1);
    expect(selected()).toEqual(["@bobbyBobby Tables"]);

    await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");
    await waitFor(() => expect(box.value).toBe("@bobby "));
  });

  it("typing again puts the highlight back on the first hit", async () => {
    const user = userEvent.setup();
    const box = renderComposer();
    await user.type(box, "@bo");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await user.keyboard("{ArrowDown}");
    expect(selected()).toEqual(["@bobbyBobby Tables"]);

    await user.type(box, "b", { skipClick: true });
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/users?search=bob&limit=8&projectId=p1"),
    );
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(selected()).toEqual(["@bobBob Jones"]);
  });

  it("keeps a highlight, and Enter working, when the list shrinks under it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    const box = renderComposer(queryClient);
    await user.type(box, "@bo");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await user.keyboard("{ArrowDown}");
    expect(selected()).toEqual(["@bobbyBobby Tables"]);

    // The search is refreshed in the background and comes back shorter.
    apiFetchMock.mockResolvedValue([{ id: "u1", username: "bob", displayName: "Bob Jones" }]);
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(selected()).toEqual(["@bobBob Jones"]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(box.value).toBe("@bob "));
  });
});
