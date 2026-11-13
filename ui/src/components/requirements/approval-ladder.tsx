/**
 * Issue #2347 (epic #2328) — the one approval ladder, said the same way
 * wherever an analyst chooses how to approve:
 *
 * 1. **Analysis checkpoint**: confirm what the analysis proposed before it is
 *    saved (the run's Checkpoints tab, formerly "Approvals");
 * 2. **Requirement approval**: an analyst marks a requirement approved
 *    directly (Approve on its card or in the Requirements list);
 * 3. **Formal review and baseline**: reviewers sign off a set; approval
 *    creates a baseline (Request review).
 *
 * #2330 (live) — a rejected formal review rejects EVERY requirement in it,
 * those already approved directly included, so the copy says so where the
 * analyst chooses between the two.
 */

/** One line at the point of choosing: what Approve does, and how a review differs. */
export const APPROVAL_LADDER_NOTE =
  "Approve marks it approved yourself, with no reviewer and no baseline. A formal review (Request review) asks colleagues to sign off a set and creates a baseline; if they reject it, every requirement in it is rejected, approved ones included.";

/** The three rungs, in order, as the Requirements tab lists them. */
export const APPROVAL_LADDER_RUNGS: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: "Analysis checkpoint",
    text: "Confirm what the analysis proposed before it is saved (the run's Checkpoints tab).",
  },
  {
    name: "Requirement approval",
    text: "Approve a requirement yourself, here or on its card.",
  },
  {
    name: "Formal review and baseline",
    text: "Request review: colleagues sign off a set, and their approval creates a baseline.",
  },
];

export function ApprovalLadderNote({ className = "" }: { className?: string }) {
  return (
    <p
      className={`text-xs text-muted-foreground ${className}`.trim()}
      data-testid="approval-ladder-note"
    >
      {APPROVAL_LADDER_NOTE}
    </p>
  );
}
