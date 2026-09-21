/**
 * Issue #1117 findings E + F — approval-gate wording and placement.
 *
 * E: "16 requirement(s) awaiting approval — 31 pending approval(s) must be
 *    resolved." Both numbers correct, counting different things, with nothing
 *    saying which was which. A reader's first assumption is that one is wrong.
 * F: a 409 from Approve rendered its explanation at the bottom of a 31-item
 *    list, off-screen from the button, as a wall of raw cuids.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { summarisePendingByType } from "@/components/analysis/ApprovalsPanel";
import { ApprovalGateBlockNotice } from "@/components/publishing/approval-gate-card";
import { APPROVAL_REQUIRED, APPROVAL_GATE_UNAVAILABLE } from "@/lib/approval-gate";

describe("#1117 E — the two counts are reconciled", () => {
  it("breaks the pending approvals down by type", () => {
    const pending = [
      ...Array.from({ length: 16 }, () => ({ type: "requirement" })),
      ...Array.from({ length: 11 }, () => ({ type: "evidence" })),
      ...Array.from({ length: 4 }, () => ({ type: "clarification" })),
    ];

    // 31 pending vs 16 requirements — the exact live numbers.
    expect(summarisePendingByType(pending)).toBe("16 requirement, 11 evidence, 4 clarification");
  });

  it("orders by count so the dominant type reads first", () => {
    expect(
      summarisePendingByType([{ type: "evidence" }, { type: "requirement" }, { type: "evidence" }]),
    ).toBe("2 evidence, 1 requirement");
  });

  it("breaks a tie deterministically rather than by insertion order", () => {
    expect(summarisePendingByType([{ type: "requirement" }, { type: "evidence" }])).toBe(
      "1 evidence, 1 requirement",
    );
  });

  it("returns null when there is nothing pending, so no caveat renders", () => {
    expect(summarisePendingByType([])).toBeNull();
  });

  it("passes an unknown approval type through rather than dropping it", () => {
    expect(summarisePendingByType([{ type: "custom" }])).toBe("1 custom");
  });
});

const block = (over: Partial<Parameters<typeof ApprovalGateBlockNotice>[0]["block"]> = {}) => ({
  code: APPROVAL_REQUIRED as typeof APPROVAL_REQUIRED,
  message: "16 requirement(s) need an approved review.",
  requirementIds: Array.from({ length: 16 }, (_, i) => `cmrq${i}aaaaaaaaaaaaaaaa`),
  unlinkedDraftIds: [],
  documentIds: [],
  ...over,
});

describe("#1117 F — the gate block is legible", () => {
  it("leads with the count instead of a wall of cuids", () => {
    render(<ApprovalGateBlockNotice block={block()} />);

    const list = screen.getByTestId("gate-requirement-ids");
    expect(list).toHaveTextContent(/16 requirement\(s\) need an approved, up-to-date review/);
    // Bounded sample, not all 16.
    expect(list).toHaveTextContent(/and 11 more/);
  });

  it("shows every id when the list is short enough to be useful", () => {
    render(<ApprovalGateBlockNotice block={block({ requirementIds: ["cmrqA", "cmrqB"] })} />);

    const list = screen.getByTestId("gate-requirement-ids");
    expect(list).toHaveTextContent("cmrqA, cmrqB");
    expect(list).not.toHaveTextContent(/more/);
  });

  it("is an alert so it is announced when it appears", () => {
    render(<ApprovalGateBlockNotice block={block()} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("omits a section that has no ids", () => {
    render(<ApprovalGateBlockNotice block={block()} />);
    expect(screen.queryByTestId("gate-unlinked-draft-ids")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gate-document-ids")).not.toBeInTheDocument();
  });

  it("names the unlinked drafts and documents when present", () => {
    render(
      <ApprovalGateBlockNotice
        block={block({ unlinkedDraftIds: ["d1"], documentIds: ["doc1", "doc2"] })}
      />,
    );

    expect(screen.getByTestId("gate-unlinked-draft-ids")).toHaveTextContent(/1 draft\(s\)/);
    expect(screen.getByTestId("gate-document-ids")).toHaveTextContent(/2 document\(s\)/);
  });

  it("still distinguishes a fail-closed gate outage from a real block", () => {
    render(<ApprovalGateBlockNotice block={block({ code: APPROVAL_GATE_UNAVAILABLE })} />);

    expect(screen.getByTestId("approval-gate-block")).toHaveTextContent(/fail-closed/);
    // No "create reviews" link — there is nothing to create; the check itself failed.
    expect(screen.queryByRole("link", { name: /reviews/i })).not.toBeInTheDocument();
  });
});
