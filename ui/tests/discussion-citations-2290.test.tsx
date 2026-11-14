/**
 * #2290 — an AI discussion reply shows its citations, each checked against
 * what the reply retrieved or read, as a chat reply does (#2242): under the
 * settled reply, linked into the thread's project repository when verified,
 * marked when not. Nothing under a human message or a reply still streaming.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/connectors-api", () => ({ repoConnectorsApi: { list } }));
vi.mock("@/lib/socket-client", () => ({ closeSocket: vi.fn(), useSocket: vi.fn() }));
vi.mock("@/lib/discussions-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/discussions-api")>()),
  listMessages: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  streamFetch: vi.fn(),
  setOnRefreshFailure: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import type { ChatCitation } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { listMessages } from "@/lib/discussions-api";
import {
  DiscussionMessageList,
  type DiscussionListMessage,
} from "@/components/chat/discussion-message-list";
import { DiscussionThreadView } from "@/components/chat/discussion-thread-view";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CITATIONS: ChatCitation[] = [
  {
    text: "internal/model/feed.go:120-150",
    path: "internal/model/feed.go",
    lines: [120, 150],
    status: "verified",
    source: "repo",
    commitSha: SHA,
  },
  { text: "src/made/up.ts:3", path: "src/made/up.ts", lines: [3, 3], status: "not-read" },
];

function msg(over: Partial<DiscussionListMessage>): DiscussionListMessage {
  return {
    id: "ai1",
    threadId: "t1",
    authorKind: "ai",
    authorUserId: null,
    aiProvider: "anthropic",
    aiModel: "claude",
    aiSessionId: "s1",
    body: "See the scheduler.",
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([
    {
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "reader",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: SHA,
      deletedAt: null,
    },
  ]);
});

function renderList(messages: DiscussionListMessage[], projectId?: string) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <DiscussionMessageList messages={messages} projectId={projectId} />
    </Wrapper>,
  );
}

describe("#2290 — citations under an AI discussion reply", () => {
  it("lists each citation, links a verified one into the project's repo, marks one not read", async () => {
    renderList([msg({ citations: CITATIONS })], "p1");

    const box = screen.getByTestId("chat-citations");
    // A citation that did not check out opens the list by itself.
    expect(box).toHaveAttribute("open");
    expect(box).toHaveTextContent("Citations · 1 verified · 1 not verified");
    const items = within(box).getAllByTestId("chat-citation");
    expect(items.map((i) => i.getAttribute("data-status"))).toEqual(["verified", "not-read"]);
    const link = await within(items[0]!).findByRole("link");
    expect(link).toHaveAttribute(
      "href",
      `https://github.com/acme/reader/blob/${SHA}/internal/model/feed.go#L120-L150`,
    );
    expect(list).toHaveBeenCalledWith("p1");
    expect(within(items[1]!).queryByRole("link")).toBeNull();
    expect(items[1]!).toHaveTextContent("not in anything this reply retrieved or read");
  });

  it("shows nothing under a human message, a reply still streaming, or one that cited nothing", () => {
    renderList([
      msg({ id: "h1", authorKind: "human", authorUserId: "u1", citations: CITATIONS }),
      msg({ id: "ai-s", streaming: true, citations: CITATIONS }),
      msg({ id: "ai-e", isError: true, citations: CITATIONS }),
      msg({ id: "ai-n" }),
    ]);
    expect(screen.queryByTestId("chat-citations")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("the thread view hands its project down, so a reloaded reply's citations link", async () => {
    vi.mocked(useSocket).mockReturnValue({ emit: vi.fn(), on: vi.fn(), off: vi.fn() } as never);
    vi.mocked(listMessages).mockResolvedValue([msg({ citations: CITATIONS })]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DiscussionThreadView threadId="t1" currentUserId="u1" projectId="p1" />
      </Wrapper>,
    );

    const box = await screen.findByTestId("chat-citations");
    const link = await within(box).findByRole("link");
    expect(link.getAttribute("href")).toContain("https://github.com/acme/reader/blob/");
    expect(list).toHaveBeenCalledWith("p1");
  });
});
