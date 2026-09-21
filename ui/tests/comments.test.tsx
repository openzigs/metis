/**
 * Epic #728 / Issue #734-#735 — Comment components tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { makeWrapper } from "./test-utils";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@/lib/collaboration-api", () => ({
  commentApi: {
    listForRequirement: vi.fn(),
    createForRequirement: vi.fn(),
    listForArtifact: vi.fn(),
    createForArtifact: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
  assignmentApi: {
    list: vi.fn(),
    assign: vi.fn(),
    unassign: vi.fn(),
  },
  requirementUpdateApi: {
    update: vi.fn(),
  },
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  setOnRefreshFailure: vi.fn(),
  streamFetch: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code: string | undefined;
    details: unknown;
    constructor(status: number, message: string, code?: string, details?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
}));

import { commentApi } from "@/lib/collaboration-api";
import type { CommentThread, CommentItem } from "@/lib/collaboration-api";

const mockCommentApi = commentApi as unknown as {
  listForRequirement: ReturnType<typeof vi.fn>;
  createForRequirement: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

// ---- Fixtures --------------------------------------------------------------

const AUTHOR = { id: "u1", username: "alice", displayName: "Alice" };
const CURRENT_USER_ID = "u1";

function makeThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "t1",
    requirementId: "req1",
    specKitProjectId: null,
    specKitArtifactName: null,
    title: "Test thread",
    resolved: false,
    comments: [makeComment()],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeComment(overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    id: "c1",
    threadId: "t1",
    authorId: "u1",
    author: AUTHOR,
    body: "Hello world",
    deleted: false,
    editedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---- CommentThread tests ---------------------------------------------------

describe("CommentThread", () => {
  // Import lazily so mock is in place
  let CommentThreadComponent: typeof import("@/components/comments/CommentThread").CommentThreadComponent;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/components/comments/CommentThread");
    CommentThreadComponent = mod.CommentThreadComponent;
  });

  function renderThread(overrides: Partial<CommentThread> = {}) {
    const Wrapper = makeWrapper({});
    const onUpdated = vi.fn();
    render(
      <Wrapper>
        <CommentThreadComponent
          thread={makeThread(overrides)}
          currentUserId={CURRENT_USER_ID}
          onUpdated={onUpdated}
        />
      </Wrapper>,
    );
    return { onUpdated };
  }

  it("renders thread title and comment body", () => {
    renderThread();
    expect(screen.getByText("Test thread")).toBeInTheDocument();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("shows Edit/Delete for own comments", () => {
    renderThread();
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });

  it("does not show Edit/Delete for other users' comments", () => {
    renderThread({
      comments: [makeComment({ authorId: "u_other" })],
    });
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("shows 'This comment was deleted.' for soft-deleted comments", () => {
    renderThread({
      comments: [makeComment({ deleted: true, body: null })],
    });
    expect(screen.getByText(/This comment was deleted/i)).toBeInTheDocument();
  });

  it("calls commentApi.edit when user saves an edit", async () => {
    mockCommentApi.edit.mockResolvedValue({
      ...makeComment(),
      body: "Updated body",
      editedAt: new Date().toISOString(),
    });
    renderThread();
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    const textarea = screen.getByDisplayValue("Hello world");
    fireEvent.change(textarea, { target: { value: "Updated body" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(mockCommentApi.edit).toHaveBeenCalledWith("c1", "Updated body");
    });
  });

  it("calls commentApi.delete when user deletes a comment", async () => {
    mockCommentApi.delete.mockResolvedValue(undefined);
    renderThread();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => {
      expect(mockCommentApi.delete).toHaveBeenCalledWith("c1");
    });
  });

  it("submits a reply via commentApi.reply", async () => {
    mockCommentApi.reply.mockResolvedValue({
      ...makeComment({ id: "c2", body: "A reply" }),
    });
    const { onUpdated } = renderThread();

    // Find the Reply textarea placeholder
    const replyBox = screen.getByPlaceholderText(/reply/i);
    fireEvent.change(replyBox, { target: { value: "A reply" } });
    fireEvent.click(screen.getByRole("button", { name: /reply/i }));

    await waitFor(() => {
      expect(mockCommentApi.reply).toHaveBeenCalledWith("t1", "A reply");
      expect(onUpdated).toHaveBeenCalled();
    });
  });
});

// ---- CommentPanel tests ----------------------------------------------------

describe("CommentPanel", () => {
  let CommentPanel: typeof import("@/components/comments/CommentPanel").CommentPanel;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/components/comments/CommentPanel");
    CommentPanel = mod.CommentPanel;
  });

  function renderPanel(open = true) {
    const Wrapper = makeWrapper({});
    const onClose = vi.fn();
    render(
      <Wrapper>
        <CommentPanel
          open={open}
          onClose={onClose}
          requirementId="req1"
          currentUserId={CURRENT_USER_ID}
          title="Req #1"
        />
      </Wrapper>,
    );
    return { onClose };
  }

  it("shows loading state initially", async () => {
    mockCommentApi.listForRequirement.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the provided requirement title in the header (#281)", () => {
    mockCommentApi.listForRequirement.mockResolvedValue([]);
    renderPanel();
    // The title prop ("Req #1") must be shown, not a generic placeholder.
    expect(screen.getByText("Req #1")).toBeInTheDocument();
    expect(screen.queryByText(/Requirement comments/i)).not.toBeInTheDocument();
  });

  it("renders threads returned from API", async () => {
    mockCommentApi.listForRequirement.mockResolvedValue([makeThread()]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  it("gives the icon-only close button an accessible name (A1 #149)", () => {
    mockCommentApi.listForRequirement.mockResolvedValue([]);
    const { onClose } = renderPanel();
    const close = screen.getByRole("button", { name: /close comments/i });
    expect(close).toBeInTheDocument();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows 'No comments yet.' when API returns empty", async () => {
    mockCommentApi.listForRequirement.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/No comments yet/i)).toBeInTheDocument();
    });
  });

  it("creates a new thread on Post", async () => {
    mockCommentApi.listForRequirement.mockResolvedValue([]);
    mockCommentApi.createForRequirement.mockResolvedValue(makeThread());
    renderPanel();
    await waitFor(() => screen.getByText(/No comments yet/i));

    const textarea = screen.getByPlaceholderText(/write a comment/i);
    fireEvent.change(textarea, { target: { value: "My first comment" } });
    fireEvent.click(screen.getByRole("button", { name: /post/i }));

    await waitFor(() => {
      expect(mockCommentApi.createForRequirement).toHaveBeenCalledWith(
        "req1",
        expect.objectContaining({ body: "My first comment" }),
      );
    });
  });

  it("does not render sheet content when closed", () => {
    mockCommentApi.listForRequirement.mockResolvedValue([]);
    renderPanel(false);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
});

// ---- MentionInput tests ----------------------------------------------------

describe("MentionInput", () => {
  let MentionInput: typeof import("@/components/comments/MentionInput").MentionInput;
  const apiFetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    const apiClientMod = await import("@/lib/api-client");
    (apiClientMod.apiFetch as ReturnType<typeof vi.fn>).mockImplementation(apiFetchMock);
    const mod = await import("@/components/comments/MentionInput");
    MentionInput = mod.MentionInput;
  });

  /** Controlled wrapper so that onChange actually updates the rendered value. */
  function ControlledInput(props: { initial?: string }) {
    const [val, setVal] = useState(props.initial ?? "");
    return <MentionInput value={val} onChange={setVal} placeholder="Type here" />;
  }

  function renderInput(initial = "") {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ControlledInput initial={initial} />
      </Wrapper>,
    );
  }

  it("renders a textarea", () => {
    renderInput();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("calls onChange when user types", () => {
    renderInput();
    // For this test we just verify the input is interactive
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(ta).toHaveValue("hello");
  });

  it("shows suggestion dropdown on @ trigger", async () => {
    apiFetchMock.mockResolvedValue([{ id: "u1", username: "bob", displayName: "Bob" }]);

    renderInput();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "@bo" } });

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
  });

  it("inserts @username on option mousedown", async () => {
    apiFetchMock.mockResolvedValue([{ id: "u1", username: "bob", displayName: "Bob" }]);

    renderInput();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "@bo" } });

    await waitFor(() => screen.getByRole("listbox"));

    const option = screen.getByText("@bob");
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("@bob ");
    });
  });

  it("navigates suggestions with ArrowDown/ArrowUp", async () => {
    apiFetchMock.mockResolvedValue([
      { id: "u1", username: "alice", displayName: "Alice" },
      { id: "u2", username: "bob", displayName: "Bob" },
    ]);
    renderInput();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@a" } });
    await waitFor(() => screen.getByRole("listbox"));

    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    // No crash — coverage for arrow key paths
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("inserts via Enter key", async () => {
    apiFetchMock.mockResolvedValue([{ id: "u1", username: "carol", displayName: "Carol" }]);
    renderInput();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@ca" } });
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("@carol ");
    });
  });

  it("closes dropdown on Escape key", async () => {
    apiFetchMock.mockResolvedValue([{ id: "u1", username: "dave", displayName: "Dave" }]);
    renderInput();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@da" } });
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });
});
