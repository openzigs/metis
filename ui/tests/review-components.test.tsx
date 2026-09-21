/**
 * Epic #609 / Issue #618 — reviewer UI component tests: badges, VersionDiff,
 * ReviewItemCard, ReviewHeader, ReviewerPanel, DecisionBar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/history-api", () => ({
  historyApi: { list: vi.fn(), restore: vi.fn(), export: vi.fn() },
}));

import { historyApi } from "@/lib/history-api";
import {
  ReviewStatusBadge,
  DueDateBadge,
  REVIEW_STATUS_LABELS,
  dueDateInfo,
} from "@/components/reviews/review-badges";
import { VersionDiff, formatDiffValue } from "@/components/reviews/VersionDiff";
import { ReviewItemCard } from "@/components/reviews/ReviewItemCard";
import { ReviewHeader, policyLabel } from "@/components/reviews/ReviewHeader";
import { ReviewerPanel } from "@/components/reviews/ReviewerPanel";
import { DecisionBar } from "@/components/reviews/DecisionBar";
import type { ReviewItem, ReviewRequest, ReviewerAssignment } from "@/lib/reviews-api";

const historyListMock = historyApi.list as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  historyListMock.mockReset();
});

// ── Badges ───────────────────────────────────────────────────────────────────

describe("ReviewStatusBadge", () => {
  it("renders a label for every status", () => {
    for (const status of ["draft", "in_review", "approved", "rejected", "closed"] as const) {
      const { unmount } = render(<ReviewStatusBadge status={status} />);
      expect(screen.getByText(REVIEW_STATUS_LABELS[status])).toBeInTheDocument();
      unmount();
    }
  });
});

describe("dueDateInfo / DueDateBadge", () => {
  it("returns null without a due date", () => {
    expect(dueDateInfo(null, "in_review")).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(dueDateInfo("not-a-date", "in_review")).toBeNull();
  });

  it("marks open reviews past due as overdue", () => {
    const info = dueDateInfo("2020-01-01T00:00:00.000Z", "in_review", new Date("2026-01-01"));
    expect(info?.overdue).toBe(true);
    expect(info?.label).toMatch(/Overdue/);
  });

  it("does not mark decided reviews as overdue", () => {
    const info = dueDateInfo("2020-01-01T00:00:00.000Z", "approved", new Date("2026-01-01"));
    expect(info?.overdue).toBe(false);
    expect(info?.label).toMatch(/Due/);
  });

  it("renders nothing without a due date and a badge with one", () => {
    const { container } = render(<DueDateBadge dueAt={null} status="in_review" />);
    expect(container).toBeEmptyDOMElement();
    render(<DueDateBadge dueAt="2020-01-01T00:00:00.000Z" status="in_review" />);
    expect(screen.getByTestId("review-due-badge")).toHaveTextContent(/Overdue/);
  });
});

// ── VersionDiff ──────────────────────────────────────────────────────────────

describe("formatDiffValue", () => {
  it("renders empty marker, strings, and JSON for objects", () => {
    expect(formatDiffValue(null)).toBe("—");
    expect(formatDiffValue(undefined)).toBe("—");
    expect(formatDiffValue("plain")).toBe("plain");
    expect(formatDiffValue(5)).toBe("5");
    expect(formatDiffValue(["a", "b"])).toBe('["a","b"]');
  });
});

describe("VersionDiff", () => {
  it("renders a from → to row per changed field", () => {
    render(
      <VersionDiff
        changedFields={{
          title: { from: "Old title", to: "New title" },
          storyPoints: { from: null, to: 5 },
        }}
      />,
    );
    const diff = screen.getByTestId("version-diff");
    expect(diff).toBeInTheDocument();
    expect(screen.getByTestId("diff-field-title")).toHaveTextContent("Old title");
    expect(screen.getByTestId("diff-field-title")).toHaveTextContent("New title");
    expect(screen.getByTestId("diff-field-storyPoints")).toHaveTextContent("—");
    expect(screen.getByTestId("diff-field-storyPoints")).toHaveTextContent("5");
  });

  it("renders an empty state when nothing changed", () => {
    render(<VersionDiff changedFields={{}} />);
    expect(screen.getByText(/No field changes recorded/i)).toBeInTheDocument();
  });
});

// ── ReviewItemCard ───────────────────────────────────────────────────────────

function makeRequirementItem(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    requirementId: "req-1",
    generatedDocumentId: null,
    pinnedVersion: 3,
    requirement: { id: "req-1", title: "Login requirement", version: 4 },
    generatedDocument: null,
    ...over,
  };
}

describe("ReviewItemCard", () => {
  it("renders the pinned snapshot and diff for a requirement item", async () => {
    historyListMock.mockResolvedValue({
      versions: [
        {
          version: 4,
          changedFields: { title: { from: "v3 title", to: "v4 title" } },
          actorId: "u1",
          reason: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          snapshot: { title: "v4 title", body: "v4 body" },
        },
        {
          version: 3,
          changedFields: { body: { from: "v2 body", to: "v3 body" } },
          actorId: "u1",
          reason: null,
          createdAt: "2026-05-01T00:00:00.000Z",
          snapshot: { title: "v3 title", body: "v3 body" },
        },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
      currentVersion: 4,
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard item={makeRequirementItem()} />
      </Wrapper>,
    );
    // Pinned snapshot (v3), not the current one (v4). "v3 body" also appears
    // as the diff's `to` value, so assert presence rather than uniqueness.
    expect(await screen.findByText("v3 title")).toBeInTheDocument();
    expect(screen.getAllByText("v3 body").length).toBeGreaterThan(0);
    expect(screen.getByText(/pinned v3/i)).toBeInTheDocument();
    // The diff introduced BY the pinned version.
    expect(screen.getByTestId("diff-field-body")).toHaveTextContent("v2 body");
    expect(historyListMock).toHaveBeenCalledWith("req-1", { pageSize: 100 });
  });

  it("falls back gracefully when the pinned version has no history entry", async () => {
    historyListMock.mockResolvedValue({
      versions: [],
      total: 0,
      page: 1,
      pageSize: 100,
      currentVersion: 4,
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard item={makeRequirementItem()} />
      </Wrapper>,
    );
    expect(await screen.findByText(/No version history for v3/i)).toBeInTheDocument();
    expect(screen.getByText("Login requirement")).toBeInTheDocument();
  });

  it("surfaces a history load error", async () => {
    historyListMock.mockRejectedValue(new Error("boom"));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard item={makeRequirementItem()} />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Failed to load version history/i)).toBeInTheDocument(),
    );
  });

  it("renders snapshot metadata fields when present", async () => {
    historyListMock.mockResolvedValue({
      versions: [
        {
          version: 3,
          changedFields: {},
          actorId: null,
          reason: null,
          createdAt: "2026-05-01T00:00:00.000Z",
          snapshot: { title: "v3 title", body: "", priority: "high", storyPoints: 8 },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
      currentVersion: 3,
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard item={makeRequirementItem()} />
      </Wrapper>,
    );
    expect(await screen.findByText("priority: high · storyPoints: 8")).toBeInTheDocument();
    // Empty body → no body paragraph; empty diff → empty-state copy.
    expect(screen.getByText(/No field changes recorded/i)).toBeInTheDocument();
  });

  it("falls back to the requirement reference title when the snapshot title is empty", async () => {
    historyListMock.mockResolvedValue({
      versions: [
        {
          version: 3,
          changedFields: { title: { from: "a", to: "b" } },
          actorId: null,
          reason: null,
          createdAt: "2026-05-01T00:00:00.000Z",
          snapshot: { title: "", body: "" },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
      currentVersion: 3,
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard item={makeRequirementItem()} />
      </Wrapper>,
    );
    expect(await screen.findByText("Login requirement")).toBeInTheDocument();
  });

  it("uses a generic title when a document item has no document reference", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard
          item={makeRequirementItem({
            id: "item-3",
            requirementId: null,
            requirement: null,
            generatedDocumentId: "doc-gone",
            generatedDocument: null,
            pinnedVersion: 1,
          })}
        />
      </Wrapper>,
    );
    expect(screen.getByText("Spec document")).toBeInTheDocument();
  });

  it("renders spec-document items without a diff", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewItemCard
          item={makeRequirementItem({
            id: "item-2",
            requirementId: null,
            requirement: null,
            generatedDocumentId: "doc-1",
            generatedDocument: { id: "doc-1", title: "System spec" },
            pinnedVersion: 2,
          })}
        />
      </Wrapper>,
    );
    expect(screen.getByText("System spec")).toBeInTheDocument();
    expect(screen.getByText(/pinned v2/i)).toBeInTheDocument();
    expect(screen.getByText(/available for requirement items only/i)).toBeInTheDocument();
    expect(historyListMock).not.toHaveBeenCalled();
  });
});

// ── ReviewHeader ─────────────────────────────────────────────────────────────

function makeReview(over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: "rev-1",
    projectId: "p-1",
    title: "Sprint 12 requirement sign-off",
    description: "Please review before the release cut.",
    status: "in_review",
    policy: "all",
    quorum: null,
    requestedById: "u-req",
    dueAt: null,
    decidedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    requestedBy: { id: "u-req", username: "requester", displayName: "Rita Requester" },
    items: [],
    assignments: [],
    baseline: null,
    ...over,
  };
}

describe("policyLabel / ReviewHeader", () => {
  it("labels both policies", () => {
    expect(policyLabel("all", null, 3)).toMatch(/All reviewers/i);
    expect(policyLabel("quorum", 2, 3)).toMatch(/2 of 3/);
    expect(policyLabel("quorum", null, 3)).toMatch(/\? of 3/);
  });

  it("renders title, status, requester, description, and baseline", () => {
    render(
      <ReviewHeader
        review={makeReview({
          status: "approved",
          baseline: { id: "b1", name: "Sprint 12 baseline", createdAt: "2026-06-03T00:00:00Z" },
        })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Sprint 12 requirement sign-off" }),
    ).toBeInTheDocument();
    expect(screen.getByText(REVIEW_STATUS_LABELS.approved)).toBeInTheDocument();
    expect(screen.getByText(/Rita Requester/)).toBeInTheDocument();
    expect(screen.getByText(/Please review before the release cut/)).toBeInTheDocument();
    // #620 — the baseline name links to the project's baseline detail page.
    const baselineLink = screen.getByRole("link", { name: "Sprint 12 baseline" });
    expect(baselineLink).toHaveAttribute("href", "/projects/p-1/baselines/b1");
  });
});

// ── ReviewerPanel ────────────────────────────────────────────────────────────

function makeAssignment(over: Partial<ReviewerAssignment> = {}): ReviewerAssignment {
  return {
    id: "a-1",
    reviewerId: "u-1",
    decision: "pending",
    note: null,
    decidedAt: null,
    reviewer: { id: "u-1", username: "alice", displayName: "Alice Reviewer" },
    ...over,
  };
}

describe("ReviewerPanel", () => {
  it("lists reviewers with decisions, notes, and a (you) marker", () => {
    render(
      <ReviewerPanel
        assignments={[
          makeAssignment(),
          makeAssignment({
            id: "a-2",
            reviewerId: "u-2",
            decision: "approved",
            note: "Ship it",
            decidedAt: "2026-06-02T10:00:00.000Z",
            reviewer: { id: "u-2", username: "bob", displayName: "Bob Approver" },
          }),
        ]}
        currentUserId="u-1"
      />,
    );
    expect(screen.getByText(/Alice Reviewer/)).toBeInTheDocument();
    expect(screen.getByText(/\(you\)/)).toBeInTheDocument();
    expect(screen.getByTestId("assignment-decision-a-2")).toHaveTextContent(/approved/i);
    expect(screen.getByText("Ship it")).toBeInTheDocument();
  });
});

// ── DecisionBar ──────────────────────────────────────────────────────────────

describe("DecisionBar", () => {
  it("submits an approval with a trimmed note", () => {
    const onDecide = vi.fn();
    render(<DecisionBar pending={false} error={null} onDecide={onDecide} />);
    fireEvent.change(screen.getByLabelText(/Decision note/i), {
      target: { value: "  looks good  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(onDecide).toHaveBeenCalledWith("approved", "looks good");
  });

  it("submits a rejection without a note", () => {
    const onDecide = vi.fn();
    render(<DecisionBar pending={false} error={null} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    expect(onDecide).toHaveBeenCalledWith("rejected", undefined);
  });

  it("disables actions while pending and surfaces errors", () => {
    render(<DecisionBar pending error="Decision failed" onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Decision failed");
  });
});
