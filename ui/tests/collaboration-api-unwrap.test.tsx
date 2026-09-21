/**
 * Issue #281 — envelope-unwrap regression tests.
 *
 * The collaboration read layer was double-unwrapping the server envelope:
 * `apiFetch` already returns `payload.data`, but `collaboration-api` then
 * returned `data.data` → `undefined`, so comments/assignments never displayed
 * and React Query threw "Query data cannot be undefined".
 *
 * These tests deliberately mock `apiFetch` at the ENVELOPE BOUNDARY: the mock
 * returns the already-unwrapped payload (exactly what the real `apiFetch`
 * yields). The REAL `collaboration-api` and the REAL `CommentPanel` /
 * assignment-rendering hooks run on top. If anyone reintroduces a second
 * `.data` unwrap, these renders will fall back to the empty state and fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { makeWrapper } from "./test-utils";

// Mock ONLY the api-client envelope boundary — collaboration-api is real.
const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  setOnRefreshFailure: vi.fn(),
  streamFetch: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { commentApi, assignmentApi } from "@/lib/collaboration-api";
import type { CommentThread, Assignment } from "@/lib/collaboration-api";
import { CommentPanel } from "@/components/comments/CommentPanel";

const AUTHOR = { id: "u1", username: "alice", displayName: "Alice" };

function unwrappedThread(): CommentThread {
  // This is what apiFetch returns AFTER unwrapping `{ success, data }`.
  return {
    id: "t1",
    requirementId: "req1",
    specKitProjectId: null,
    specKitArtifactName: null,
    title: "Login flow",
    resolved: false,
    comments: [
      {
        id: "c1",
        threadId: "t1",
        authorId: "u1",
        author: AUTHOR,
        body: "This needs a second reviewer",
        deleted: false,
        editedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function unwrappedAssignment(): Assignment {
  return {
    id: "a1",
    requirementId: "req1",
    assigneeId: "u2",
    assignedById: "u1",
    assignee: { id: "u2", username: "bob", displayName: "Bob Builder" },
    assignedBy: AUTHOR,
    slaDeadline: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("collaboration-api envelope unwrap (no double-unwrap)", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("listForRequirement returns the array directly (not undefined)", async () => {
    apiFetchMock.mockResolvedValue([unwrappedThread()]);
    const result = await commentApi.listForRequirement("req1");
    // The bug returned `undefined` here.
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].comments[0].body).toBe("This needs a second reviewer");
  });

  it("assignmentApi.list returns the array directly (not undefined)", async () => {
    apiFetchMock.mockResolvedValue([unwrappedAssignment()]);
    const result = await assignmentApi.list("req1");
    expect(result).toBeDefined();
    expect(result[0].assignee.displayName).toBe("Bob Builder");
  });

  it("createForRequirement returns the created thread (not undefined)", async () => {
    apiFetchMock.mockResolvedValue(unwrappedThread());
    const result = await commentApi.createForRequirement("req1", { body: "hi" });
    expect(result).toBeDefined();
    expect(result.id).toBe("t1");
  });

  it("renders a non-empty comments thread through CommentPanel", async () => {
    apiFetchMock.mockResolvedValue([unwrappedThread()]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <CommentPanel open onClose={() => {}} requirementId="req1" title="Login flow" />
      </Wrapper>,
    );
    // Comment body renders → proves the read layer did NOT return undefined.
    await waitFor(() => {
      expect(screen.getByText("This needs a second reviewer")).toBeInTheDocument();
    });
    expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument();
  });

  it("renders an assignment via assignmentApi.list (React Query data defined)", async () => {
    apiFetchMock.mockResolvedValue([unwrappedAssignment()]);

    function AssignmentBadge() {
      const { data = [] } = useQuery<Assignment[]>({
        queryKey: ["assignments", "req1"],
        queryFn: () => assignmentApi.list("req1"),
      });
      return (
        <div>
          {data.map((a) => (
            <span key={a.id}>{a.assignee.displayName}</span>
          ))}
        </div>
      );
    }

    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AssignmentBadge />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(screen.getByText("Bob Builder")).toBeInTheDocument();
    });
  });
});
