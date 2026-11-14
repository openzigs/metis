/**
 * Issue #2347 (epic #2328) — the one approval ladder, said the same way
 * wherever an analyst chooses how to approve:
 *
 * 1. **Analysis checkpoint**: confirm what the analysis proposed before it is
 *    saved (the run's Checkpoints tab, formerly "Approvals");
 * 2. **Requirement approval**: an analyst marks a requirement approved
 *    directly (Approve on its card or in the Requirements list);
 * 3. **Formal review and baseline**: reviewers sign off a set; approval
 *    creates a baseline. On the Requirements tab, "Request review of N
 *    selected" covers the ticked rows, and "Request review of this change
 *    request" the whole selected change request: two scopes, two names.
 *
 * #2330 (live) — a rejected formal review rejects EVERY requirement in it,
 * those already approved directly included, so the copy says so where the
 * analyst chooses between the two.
 *
 * #2436 — direct approval needs `requirement.approve`, and is maker-checker:
 * the author of a requirement (anyone who wrote or edited it) cannot approve
 * it, nor sign off their own review, unless the project allows self-approval.
 */

import Link from "next/link";

/**
 * #2436 — the maker-checker rule, in one sentence, wherever approval is offered.
 * #2452 — it names Project settings, where an analyst looks for a project-wide
 * rule; the setting is also on Deliverables → Publish.
 */
export const SELF_APPROVAL_RULE =
  "You cannot approve a requirement you wrote or edited, unless the project allows self-approval (Project settings → Approval gate).";

/**
 * #2452 — why Approve is disabled on a requirement the viewer wrote or edited,
 * in a project that does not allow self-approval: said before the click, as
 * the permission is, rather than as a refusal toast after it. #2462 — shared by
 * the Requirements list and the change request page's requirement cards.
 */
export const SELF_APPROVAL_HINT =
  "You wrote or edited this requirement, so someone else must approve it. You can still request a review. An admin can allow self-approval in Project settings → Approval gate.";

/** #2452 — where the self-approval setting is, as a link: its card on Project settings. */
export function approvalGateSettingsHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/settings#approval-gate`;
}

/** One line at the point of choosing: what Approve does, and how a review differs. */
export const APPROVAL_LADDER_NOTE = `Approve marks it approved yourself, with no reviewer and no baseline. ${SELF_APPROVAL_RULE} A formal review (on the Requirements tab: Request review of the rows you tick, or of a whole change request) asks colleagues to sign off a set and creates a baseline; if they reject it, every requirement in it is rejected, approved ones included.`;

/** The three rungs, in order, as the Requirements tab lists them. */
export const APPROVAL_LADDER_RUNGS: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: "Analysis checkpoint",
    text: "Confirm what the analysis proposed before it is saved (the run's Checkpoints tab).",
  },
  {
    name: "Requirement approval",
    text: `Approve a requirement yourself, here or on its card (requirement.approve). ${SELF_APPROVAL_RULE}`,
  },
  {
    name: "Formal review and baseline",
    text: "Tick rows and Request review of them, or Request review of this change request below: colleagues sign off the set, and their approval creates a baseline.",
  },
];

export function ApprovalLadderNote({
  className = "",
  projectId,
}: {
  className?: string;
  /** #2452 — when given, the note links straight to the self-approval setting. */
  projectId?: string;
}) {
  return (
    <p
      className={`text-xs text-muted-foreground ${className}`.trim()}
      data-testid="approval-ladder-note"
    >
      {APPROVAL_LADDER_NOTE}
      {projectId ? (
        <>
          {" "}
          <Link
            href={approvalGateSettingsHref(projectId)}
            className="underline underline-offset-2"
            data-testid="approval-gate-settings-link"
          >
            Self-approval setting
          </Link>
        </>
      ) : null}
    </p>
  );
}
