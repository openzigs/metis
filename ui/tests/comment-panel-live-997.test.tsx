/**
 * #997 — a requirement's comment panel shows another user's reply without a
 * reload.
 *
 * Root cause: `CommentThreadComponent` copied `thread.comments` into local
 * state once, so a refetch carrying the other user's reply (the viewer's own
 * post or edit refetches) never reached the screen. Second half: the panel now
 * follows `comment:changed` on the project room, so the refetch also happens
 * when someone else writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { CommentChangedEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket | null;
vi.mock("@/lib/socket-client", () => ({
  // AuthProvider closes the socket whenever the session ends (#1391).
  closeSocket: vi.fn(),
  useSocket: () => socket,
}));

vi.mock("@/lib/collaboration-api", () => ({
  commentApi: {
    listForRequirement: vi.fn(),
    listForArtifact: vi.fn(),
    createForRequirement: vi.fn(),
    createForArtifact: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn().mockResolvedValue([]) };
});

import { commentApi } from "@/lib/collaboration-api";
import type { CommentItem, CommentThread } from "@/lib/collaboration-api";
import { CommentThreadComponent } from "@/components/comments/CommentThread";
import { CommentPanel, isForThisPanel } from "@/components/comments/CommentPanel";

const api = commentApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function comment(id: string, authorId: string, body: string): CommentItem {
  return {
    id,
    threadId: "t1",
    authorId,
    author: { id: authorId, username: authorId, displayName: authorId },
    body,
    deleted: false,
    editedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function thread(comments: CommentItem[]): CommentThread {
  return {
    id: "t1",
    requirementId: "req1",
    specKitProjectId: null,
    specKitArtifactName: null,
    title: null,
    resolved: false,
    comments,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const changed = (over: Partial<CommentChangedEvent> = {}): CommentChangedEvent => ({
  projectId: "p1",
  threadId: "t1",
  requirementId: "req1",
  artifactName: null,
  ts: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  socket = createFakeSocket();
});

describe("CommentThreadComponent adopts a refetched list (#997 root cause)", () => {
  it("shows another user's reply when the panel hands it a newer list", () => {
    const Wrapper = makeWrapper({});
    const first = thread([comment("c1", "admin", "Admin's comment")]);
    const { rerender } = render(
      <Wrapper>
        <CommentThreadComponent thread={first} currentUserId="admin" onUpdated={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.queryByText("Coordinator's reply")).not.toBeInTheDocument();

    const refetched = thread([...first.comments, comment("c2", "coord", "Coordinator's reply")]);
    rerender(
      <Wrapper>
        <CommentThreadComponent thread={refetched} currentUserId="admin" onUpdated={vi.fn()} />
      </Wrapper>,
    );

    expect(screen.getByText("Coordinator's reply")).toBeInTheDocument();
  });
});

describe("CommentPanel follows comment:changed (#997)", () => {
  function renderPanel(props: Partial<Parameters<typeof CommentPanel>[0]> = {}) {
    const Wrapper = makeWrapper({});
    return render(
      <Wrapper>
        <CommentPanel
          open
          onClose={vi.fn()}
          requirementId="req1"
          projectId="p1"
          currentUserId="admin"
          {...props}
        />
      </Wrapper>,
    );
  }

  it("joins the project room and shows the other user's reply when it is pushed", async () => {
    api.listForRequirement.mockResolvedValueOnce([
      thread([comment("c1", "admin", "Admin's comment")]),
    ]);
    renderPanel();
    expect(await screen.findByText("Admin's comment")).toBeInTheDocument();
    expect(socket!.emitted("subscribe:project", { projectId: "p1" })).toBe(1);

    api.listForRequirement.mockResolvedValueOnce([
      thread([comment("c1", "admin", "Admin's comment"), comment("c2", "coord", "On it")]),
    ]);
    act(() => socket!.fire("comment:changed", changed()));

    expect(await screen.findByText("On it")).toBeInTheDocument();
    expect(api.listForRequirement).toHaveBeenCalledTimes(2);
  });

  it("ignores a change on another requirement", async () => {
    api.listForRequirement.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(api.listForRequirement).toHaveBeenCalledTimes(1));

    act(() => socket!.fire("comment:changed", changed({ requirementId: "other" })));

    await new Promise((r) => setTimeout(r, 20));
    expect(api.listForRequirement).toHaveBeenCalledTimes(1);
  });

  it("re-reads after a reconnect, for a change pushed during the gap", async () => {
    api.listForRequirement.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(api.listForRequirement).toHaveBeenCalledTimes(1));

    act(() => socket!.reconnect());

    await waitFor(() => expect(api.listForRequirement).toHaveBeenCalledTimes(2));
    expect(socket!.emitted("subscribe:project", { projectId: "p1" })).toBe(2);
  });

  it("follows an artifact's changes in Spec Kit mode", async () => {
    api.listForArtifact.mockResolvedValue([]);
    renderPanel({ requirementId: undefined, artifactName: "plan.md" });
    await waitFor(() => expect(api.listForArtifact).toHaveBeenCalledTimes(1));

    act(() =>
      socket!.fire("comment:changed", changed({ requirementId: null, artifactName: "plan.md" })),
    );

    await waitFor(() => expect(api.listForArtifact).toHaveBeenCalledTimes(2));
  });

  it("stops listening when the panel closes", async () => {
    api.listForRequirement.mockResolvedValue([]);
    const { rerender } = renderPanel();
    expect(socket!.listeners("comment:changed")).toBe(1);

    const Wrapper = makeWrapper({});
    rerender(
      <Wrapper>
        <CommentPanel open={false} onClose={vi.fn()} requirementId="req1" projectId="p1" />
      </Wrapper>,
    );

    expect(socket!.listeners("comment:changed")).toBe(0);
  });

  it("does not subscribe without a project or a socket", () => {
    api.listForRequirement.mockResolvedValue([]);
    renderPanel({ projectId: undefined });
    expect(socket!.listeners("comment:changed")).toBe(0);

    socket = null;
    expect(() => renderPanel()).not.toThrow();
  });
});

describe("isForThisPanel", () => {
  it("matches the requirement in requirement mode", () => {
    expect(isForThisPanel(changed(), { projectId: "p1", requirementId: "req1" })).toBe(true);
    expect(isForThisPanel(changed(), { projectId: "p1", requirementId: "req2" })).toBe(false);
  });

  it("never matches another project's event", () => {
    expect(isForThisPanel(changed(), { projectId: "p2", requirementId: "req1" })).toBe(false);
  });

  it("matches the artifact in Spec Kit mode", () => {
    const event = changed({ requirementId: null, artifactName: "plan.md" });
    expect(isForThisPanel(event, { projectId: "p1", artifactName: "plan.md" })).toBe(true);
    expect(isForThisPanel(event, { projectId: "p1", artifactName: "spec.md" })).toBe(false);
    expect(isForThisPanel(event, { projectId: "p1" })).toBe(false);
  });
});
