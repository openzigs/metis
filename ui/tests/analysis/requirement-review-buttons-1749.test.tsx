/**
 * #1749 — Approve stayed clickable after approval, and a second click sent a
 * second PUT. A state already set reads as done and is not offered again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RequirementReviewButtons,
  effectiveReviewStatus,
} from "@/components/analysis/requirement-review-buttons";

afterEach(cleanup);

function renderButtons(
  status: string | null,
  opts: { writeHint?: string; pending?: boolean } = {},
) {
  const onReview = vi.fn();
  render(
    <RequirementReviewButtons
      status={status}
      writeHint={opts.writeHint}
      pending={opts.pending ?? false}
      onReview={onReview}
    />,
  );
  return onReview;
}

describe("RequirementReviewButtons (#1749)", () => {
  it("offers both decisions on a requirement not yet reviewed", () => {
    const onReview = renderButtons("pending");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReview.mock.calls).toEqual([["approved"], ["rejected"]]);
  });

  it("reads Approved and sends nothing on an approved requirement, and Reject stays open", () => {
    const onReview = renderButtons("approved");
    const approved = screen.getByRole("button", { name: "Approved" });
    expect(approved).toBeDisabled();
    expect(approved).toHaveAttribute("aria-pressed", "true");
    expect(approved.parentElement).toHaveAttribute("title", "Already approved.");
    fireEvent.click(approved);
    expect(onReview).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReview).toHaveBeenCalledWith("rejected");
  });

  it("reads Rejected on a rejected requirement, and Approve stays open", () => {
    renderButtons("rejected");
    expect(screen.getByRole("button", { name: "Rejected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("disables both while a review is in flight", () => {
    renderButtons(null, { pending: true });
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("disables both, with the write hint, for a viewer who cannot write", () => {
    renderButtons("approved", { writeHint: "Requires project.update" });
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approved" }).parentElement).toHaveAttribute(
      "title",
      "Requires project.update",
    );
  });
});

describe("effectiveReviewStatus (#1749)", () => {
  const req = { id: "r1", version: 3, reviewStatus: "pending" };

  it("is the stored status when nothing has been reviewed on the page", () => {
    expect(effectiveReviewStatus(req, null)).toBe("pending");
    expect(effectiveReviewStatus({ id: "r1", version: 3 }, undefined)).toBeNull();
  });

  it("is the review just set while the requirement read back is the version it was set on", () => {
    expect(effectiveReviewStatus(req, { reqId: "r1", reviewStatus: "approved", version: 3 })).toBe(
      "approved",
    );
  });

  it("gives way to the stored status once the requirement is read again after the review (#2184 panel)", () => {
    const settled = { reqId: "r1", reviewStatus: "approved" as const, version: 3 };
    // Before the read-back: the review just sent still counts.
    expect(effectiveReviewStatus(req, settled, { readAt: 100, sentAt: 200 })).toBe("approved");
    // A read after it is the truth, even at the same version: a review alone
    // does not bump the version, so a later reject elsewhere reads back here.
    const rejected = { ...req, reviewStatus: "rejected" };
    expect(effectiveReviewStatus(rejected, settled, { readAt: 300, sentAt: 200 })).toBe("rejected");
  });

  it("ignores a review of another requirement, or of an older version", () => {
    expect(effectiveReviewStatus(req, { reqId: "r2", reviewStatus: "approved", version: 3 })).toBe(
      "pending",
    );
    expect(effectiveReviewStatus(req, { reqId: "r1", reviewStatus: "approved", version: 2 })).toBe(
      "pending",
    );
  });
});
