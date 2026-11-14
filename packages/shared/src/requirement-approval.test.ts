/**
 * Issue #2219 — the Edit dialog's warning that saving reopens an approval.
 */
import { describe, expect, it } from "vitest";
import {
  approvalEditWarning,
  type RequirementApproval,
  type RequirementApprovalReview,
} from "./requirement-approval.js";

const review = (over: Partial<RequirementApprovalReview> = {}): RequirementApprovalReview => ({
  id: "rev-1",
  title: "Security sign-off",
  status: "approved",
  pinnedVersion: 1,
  approvedBy: ["Test Coordinator"],
  ...over,
});

const approval = (over: Partial<RequirementApproval> = {}): RequirementApproval => ({
  requirementId: "req-1",
  version: 1,
  reviewStatus: "approved",
  reviews: [review()],
  ...over,
});

describe("approvalEditWarning", () => {
  it("names the approved version, the approver and the version the save creates", () => {
    expect(approvalEditWarning(approval())).toBe(
      "Approved as v1 by Test Coordinator; saving creates v2 and reopens review.",
    );
  });

  it("lists every approver of the round", () => {
    expect(
      approvalEditWarning(approval({ reviews: [review({ approvedBy: ["A", "B", "C"] })] })),
    ).toBe("Approved as v1 by A, B and C; saving creates v2 and reopens review.");
    expect(approvalEditWarning(approval({ reviews: [review({ approvedBy: ["A", "B"] })] }))).toBe(
      "Approved as v1 by A and B; saving creates v2 and reopens review.",
    );
    expect(approvalEditWarning(approval({ reviews: [review({ approvedBy: [] })] }))).toBe(
      "Approved as v1; saving creates v2 and reopens review.",
    );
  });

  it("warns that reviewers of an open review keep deciding on the pinned version", () => {
    const warning = approvalEditWarning(
      approval({
        reviewStatus: "draft",
        reviews: [review({ status: "in_review", approvedBy: [] })],
      }),
    );
    expect(warning).toBe(
      'In review as v1 ("Security sign-off"); saving creates v2, and the reviewers keep deciding on v1 unless the review is withdrawn and submitted again.',
    );
  });

  it("says an in-review save also drops the requirement's own approval (#2224)", () => {
    const warning = approvalEditWarning(
      approval({
        reviewStatus: "approved",
        reviews: [review({ status: "in_review", approvedBy: [] })],
      }),
    );
    expect(warning).toBe(
      'In review as v1 ("Security sign-off"); saving creates v2, and the reviewers keep deciding on v1 unless the review is withdrawn and submitted again. It also goes from approved back to awaiting review.',
    );
  });

  it("prefers an approval over an open review of the same version", () => {
    const warning = approvalEditWarning(
      approval({ reviews: [review({ id: "rev-2", status: "in_review" }), review()] }),
    );
    expect(warning).toMatch(/^Approved as v1 by Test Coordinator/);
  });

  it("falls back to the requirement's own approval when no review pinned it", () => {
    expect(approvalEditWarning(approval({ reviews: [] }))).toBe(
      "Approved as v1; saving creates v2 and returns it to awaiting review.",
    );
  });

  it("skips a review whose pin is already out of date", () => {
    expect(
      approvalEditWarning(
        approval({ version: 3, reviewStatus: "draft", reviews: [review({ pinnedVersion: 1 })] }),
      ),
    ).toBeNull();
  });

  it("says nothing for a requirement with no approval and no open review", () => {
    expect(approvalEditWarning(approval({ reviewStatus: "draft", reviews: [] }))).toBeNull();
    expect(approvalEditWarning(approval({ reviewStatus: null, reviews: [] }))).toBeNull();
    expect(approvalEditWarning(null)).toBeNull();
    expect(approvalEditWarning(undefined)).toBeNull();
  });
});
