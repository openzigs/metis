"use client";

/**
 * #1749 — Approve and Reject on a requirement card.
 *
 * A requirement already in a state does not offer that state again: an
 * approved one reads "Approved" and its button is disabled, so a second click
 * no longer sends a second `PUT /api/requirements/:id` (the walkthrough saw two
 * for one requirement). The other action stays available, so a decision can
 * still be changed. A review that has just succeeded counts before the
 * requirement is read back, which closes the gap a quick second click fell into.
 */
import type { RequirementReviewStatus } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { HoverHint } from "@/components/spec-kit/hover-hint";

/** The review that last succeeded on the page, as the mutation recorded it. */
export interface SettledReview {
  reqId: string;
  reviewStatus: RequirementReviewStatus;
  /** The version the review was sent against. */
  version: number;
}

/**
 * The requirement's review status as the card should show it: the one just
 * set, while the requirement read back is still the version it was set on.
 */
export function effectiveReviewStatus(
  req: { id: string; version: number; reviewStatus?: string | null },
  settled: SettledReview | null | undefined,
): string | null {
  if (settled && settled.reqId === req.id && settled.version === req.version) {
    return settled.reviewStatus;
  }
  return req.reviewStatus ?? null;
}

interface Props {
  /** The status {@link effectiveReviewStatus} gives. */
  status: string | null;
  /** The viewer's reason they cannot write, when they cannot. */
  writeHint?: string;
  /** Whether a review request is in flight. */
  pending: boolean;
  onReview: (status: "approved" | "rejected") => void;
}

const ACTIONS = [
  { status: "approved", idle: "Approve", done: "Approved" },
  { status: "rejected", idle: "Reject", done: "Rejected" },
] as const;

export function RequirementReviewButtons({ status, writeHint, pending, onReview }: Props) {
  return (
    <>
      {ACTIONS.map((a) => {
        const done = status === a.status;
        return (
          <HoverHint
            key={a.status}
            hint={writeHint ?? (done ? `Already ${a.done.toLowerCase()}.` : undefined)}
          >
            <Button
              size="sm"
              variant={done ? "default" : "outline"}
              onClick={() => onReview(a.status)}
              disabled={writeHint !== undefined || pending || done}
              aria-pressed={done}
            >
              {done ? a.done : a.idle}
            </Button>
          </HoverHint>
        );
      })}
    </>
  );
}
