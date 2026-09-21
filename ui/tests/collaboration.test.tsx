/**
 * Epic #728 / Issue #736-#737 — Collaboration UI component tests.
 * Covers PresenceAvatars, AssigneePicker, SLABadge, MergeConflictModal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@/lib/socket-client", () => ({
  useSocket: vi.fn(),
}));

vi.mock("@/lib/collaboration-api", () => ({
  assignmentApi: {
    list: vi.fn(),
    assign: vi.fn(),
    unassign: vi.fn(),
  },
  commentApi: {
    listForRequirement: vi.fn(),
    createForRequirement: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
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
    constructor(s: number, m: string, c?: string, d?: unknown) {
      super(m);
      this.status = s;
      this.code = c;
      this.details = d;
    }
  },
}));

import { useSocket } from "@/lib/socket-client";
import { assignmentApi } from "@/lib/collaboration-api";
import type { Assignment } from "@/lib/collaboration-api";

const useSocketMock = useSocket as ReturnType<typeof vi.fn>;
const assignmentApiMock = assignmentApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  assign: ReturnType<typeof vi.fn>;
  unassign: ReturnType<typeof vi.fn>;
};

// ---- PresenceAvatars -------------------------------------------------------

describe("PresenceAvatars", () => {
  let PresenceAvatars: typeof import("@/components/presence/PresenceAvatars").PresenceAvatars;
  let mockSocket: {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    mockSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    useSocketMock.mockReturnValue(mockSocket);
    const mod = await import("@/components/presence/PresenceAvatars");
    PresenceAvatars = mod.PresenceAvatars;
  });

  function renderAvatars(artifactType = "requirement", artifactId = "req1") {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PresenceAvatars artifactType={artifactType} artifactId={artifactId} />
      </Wrapper>,
    );
  }

  it("emits presence:join on mount", () => {
    renderAvatars();
    expect(mockSocket.emit).toHaveBeenCalledWith("presence:join", {
      artifactType: "requirement",
      artifactId: "req1",
    });
  });

  it("registers presence:update listener", () => {
    renderAvatars();
    expect(mockSocket.on).toHaveBeenCalledWith("presence:update", expect.any(Function));
  });

  it("renders nothing when no users present", () => {
    renderAvatars();
    // No update event fired → empty state → renders null
    expect(screen.queryByLabelText(/user\(s\) viewing/i)).not.toBeInTheDocument();
  });

  // B1/C1 — the server (server/src/lib/collaboration/presence.ts) emits
  // `presence:update` with `{ room, users, ts }` and does NOT echo back
  // artifactType/artifactId. These tests fire that ACTUAL payload to lock the
  // server↔client contract (the prior tests fired a fictional shape, which is
  // why the avatars-never-render bug slipped through).
  type PresenceUpdate = {
    room: string;
    users: { userId: string; username: string }[];
    ts: number;
  };
  function getUpdateHandler(): ((u: PresenceUpdate) => void) | undefined {
    return mockSocket.on.mock.calls.find(
      (args: unknown[]) => args[0] === "presence:update",
    )?.[1] as ((u: PresenceUpdate) => void) | undefined;
  }

  it("renders avatars when a presence:update fires for the matching room", async () => {
    renderAvatars("spec-kit-artifact", "p1:spec.md");
    const handler = getUpdateHandler();
    expect(handler).toBeDefined();
    handler?.({
      room: "presence:spec-kit-artifact:p1:spec.md",
      users: [
        { userId: "u1", username: "alice" },
        { userId: "u2", username: "bob" },
      ],
      ts: Date.now(),
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/2 user\(s\) viewing/i)).toBeInTheDocument();
    });
    expect(screen.getByText("AL")).toBeInTheDocument();
    expect(screen.getByText("BO")).toBeInTheDocument();
  });

  it("renders a +N overflow badge when users exceed maxVisible", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PresenceAvatars artifactType="requirement" artifactId="req1" maxVisible={2} />
      </Wrapper>,
    );
    const handler = getUpdateHandler();
    handler?.({
      room: "presence:requirement:req1",
      users: [
        { userId: "u1", username: "alice" },
        { userId: "u2", username: "bob" },
        { userId: "u3", username: "carol" },
        { userId: "u4", username: "dave" },
      ],
      ts: Date.now(),
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/4 user\(s\) viewing/i)).toBeInTheDocument();
    });
    // 2 visible + "+2" overflow.
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("ignores presence:update events for a different room", async () => {
    renderAvatars("requirement", "req1");
    const handler = getUpdateHandler();
    handler?.({
      room: "presence:requirement:OTHER",
      users: [{ userId: "u1", username: "alice" }],
      ts: Date.now(),
    });
    expect(screen.queryByLabelText(/user\(s\) viewing/i)).not.toBeInTheDocument();
  });

  it("renders nothing when socket is null", () => {
    useSocketMock.mockReturnValue(null);
    renderAvatars();
    expect(screen.queryByLabelText(/user\(s\) viewing/i)).not.toBeInTheDocument();
  });

  // Issue #418 — the presence payload carries one entry per live CONNECTION, so
  // the same userId can appear twice (a user with two tabs). Previously avatars
  // were keyed by userId, which collided → React duplicate-key warning. These
  // tests lock the fix: no duplicate-key error, and the count/render dedupe to
  // DISTINCT users.
  it("does not emit a duplicate-key warning when one user has two connections", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAvatars("requirement", "req1");
    const handler = getUpdateHandler();
    handler?.({
      room: "presence:requirement:req1",
      users: [
        { userId: "u1", username: "alice" },
        { userId: "u1", username: "alice" }, // same user, second tab
      ],
      ts: Date.now(),
    });

    await waitFor(() => {
      // Deduped to one distinct user.
      expect(screen.getByLabelText(/1 user\(s\) viewing/i)).toBeInTheDocument();
    });
    const duplicateKeyCall = errorSpy.mock.calls.find((args) =>
      String(args[0]).includes("Encountered two children with the same key"),
    );
    expect(duplicateKeyCall).toBeUndefined();
    errorSpy.mockRestore();
  });

  it("renders one avatar per distinct user even with multiple connections", async () => {
    renderAvatars("requirement", "req1");
    const handler = getUpdateHandler();
    handler?.({
      room: "presence:requirement:req1",
      users: [
        { userId: "u1", username: "alice" },
        { userId: "u1", username: "alice" },
        { userId: "u2", username: "bob" },
      ],
      ts: Date.now(),
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/2 user\(s\) viewing/i)).toBeInTheDocument();
    });
    // Exactly one "AL" avatar despite two alice connections.
    expect(screen.getAllByText("AL")).toHaveLength(1);
    expect(screen.getByText("BO")).toBeInTheDocument();
  });
});

// ---- SLABadge --------------------------------------------------------------

describe("SLABadge", () => {
  let SLABadge: typeof import("@/components/requirements/SLABadge").SLABadge;

  beforeEach(async () => {
    const mod = await import("@/components/requirements/SLABadge");
    SLABadge = mod.SLABadge;
  });

  function renderBadge(deadline: string | null | undefined) {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <SLABadge deadline={deadline} />
      </Wrapper>,
    );
  }

  it("shows 'No SLA' when deadline is null", () => {
    renderBadge(null);
    expect(screen.getByText(/No SLA/i)).toBeInTheDocument();
  });

  it("shows green for future deadline > 48h", () => {
    const future = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    renderBadge(future);
    const badge = screen.getByText(/due in/i).closest("span");
    expect(badge?.className).toContain("emerald");
  });

  it("shows amber for deadline ≤ 48h", () => {
    const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    renderBadge(soon);
    const badge = screen.getByText(/due in/i).closest("span");
    expect(badge?.className).toContain("amber");
  });

  it("shows red for overdue deadline", () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    renderBadge(past);
    const badge = screen.getByText(/overdue/i).closest("span");
    expect(badge?.className).toContain("red");
  });
});

// ---- AssigneePicker --------------------------------------------------------

describe("AssigneePicker", () => {
  let AssigneePicker: typeof import("@/components/requirements/AssigneePicker").AssigneePicker;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/components/requirements/AssigneePicker");
    AssigneePicker = mod.AssigneePicker;
  });

  function renderPicker(assignments: Assignment[] = []) {
    assignmentApiMock.list.mockResolvedValue(assignments);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AssigneePicker requirementId="req1" />
      </Wrapper>,
    );
  }

  it("renders the add-assignee button", async () => {
    renderPicker([]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add assignee/i })).toBeInTheDocument();
    });
  });

  it("shows existing assignees", async () => {
    const assignment: Assignment = {
      id: "a1",
      requirementId: "req1",
      assigneeId: "u1",
      assignedById: "u0",
      assignee: { id: "u1", username: "alice", displayName: "Alice" },
      assignedBy: { id: "u0", username: "admin", displayName: "Admin" },
      slaDeadline: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    renderPicker([assignment]);
    await waitFor(() => {
      expect(screen.getByText("@alice")).toBeInTheDocument();
    });
  });

  it("calls unassign on remove click", async () => {
    assignmentApiMock.unassign.mockResolvedValue(undefined);
    assignmentApiMock.list.mockResolvedValue([
      {
        id: "a1",
        requirementId: "req1",
        assigneeId: "u1",
        assignedById: "u0",
        assignee: { id: "u1", username: "alice", displayName: "Alice" },
        assignedBy: { id: "u0", username: "admin", displayName: "Admin" },
        slaDeadline: null,
        resolvedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AssigneePicker requirementId="req1" />
      </Wrapper>,
    );
    await waitFor(() => screen.getByText("@alice"));
    fireEvent.click(screen.getByRole("button", { name: /remove alice/i }));
    await waitFor(() => {
      expect(assignmentApiMock.unassign).toHaveBeenCalledWith("req1", "u1");
    });
  });
});

// ---- MergeConflictModal ---------------------------------------------------

describe("MergeConflictModal", () => {
  let MergeConflictModal: typeof import("@/components/requirements/MergeConflictModal").MergeConflictModal;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import("@/components/requirements/MergeConflictModal");
    MergeConflictModal = mod.MergeConflictModal;
  });

  const conflict = {
    clientValue: { title: "My version", description: "Client desc" },
    serverValue: { title: "Server version", description: "Server desc" },
    serverVersion: 3,
  };

  function renderModal(onResolve = vi.fn(), onDismiss = vi.fn()) {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <MergeConflictModal conflict={conflict} onResolve={onResolve} onDismiss={onDismiss} />
      </Wrapper>,
    );
    return { onResolve, onDismiss };
  }

  it("renders the conflict modal title", () => {
    renderModal();
    expect(screen.getByText(/Merge Conflict/i)).toBeInTheDocument();
  });

  it("shows field diffs for changed fields", () => {
    renderModal();
    // "My version" and "Server version" should both be visible in the diffs
    expect(screen.getAllByText("My version").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Server version").length).toBeGreaterThan(0);
  });

  it("calls onResolve with server value when 'Accept server version' selected", async () => {
    const onResolve = vi.fn();
    renderModal(onResolve);
    // "Accept server version" is already selected by default
    fireEvent.click(screen.getByRole("button", { name: /resolve & save/i }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Server version" }),
        3,
      );
    });
  });

  it("calls onResolve with client value when 'Keep my version' selected", async () => {
    const onResolve = vi.fn();
    renderModal(onResolve);
    // Select "Keep my version"
    fireEvent.click(screen.getByLabelText(/keep my version/i));
    fireEvent.click(screen.getByRole("button", { name: /resolve & save/i }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ title: "My version" }), 3);
    });
  });

  it("calls onDismiss when Cancel is clicked", () => {
    const onDismiss = vi.fn();
    renderModal(vi.fn(), onDismiss);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("renders null when no conflict is provided", () => {
    const Wrapper = makeWrapper({});
    const { container } = render(
      <Wrapper>
        <MergeConflictModal conflict={null} onResolve={vi.fn()} onDismiss={vi.fn()} />
      </Wrapper>,
    );
    expect(container.firstChild).toBeNull();
  });
});
