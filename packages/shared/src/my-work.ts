/**
 * #2348 — "My work" on Home: the caller's change requests that need attention,
 * grouped by state, and the reviews waiting on the caller's decision.
 *
 * `GET /api/me/work` (`server/src/routes/me.ts`) is the one source of these
 * states; Home renders them and nothing recomputes them on the client.
 */

/**
 * The states a change request is listed under on Home, in display order.
 * `waiting_on_me`: its clarifying questions have unanswered entries;
 * `in_review` / `rejected`: the latest formal review covering its
 * requirements is in that state; `ready_to_hand_off`: that review approved.
 */
export const MY_WORK_STATES = [
  "waiting_on_me",
  "in_review",
  "rejected",
  "ready_to_hand_off",
] as const;

export type MyWorkState = (typeof MY_WORK_STATES)[number];

/** Plain-language group headings for each state. */
export const MY_WORK_STATE_LABELS: Record<MyWorkState, string> = {
  waiting_on_me: "Waiting on your answers",
  in_review: "In review",
  rejected: "Rejected",
  ready_to_hand_off: "Ready to hand off",
};

/** One change request (today's analysis run) the caller started. */
export interface MyWorkChangeRequest {
  /** The analysis run id. */
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  state: MyWorkState;
  /** ISO time the change request entered `state`. */
  since: string;
  /** Unanswered clarifying questions; set for `waiting_on_me` only. */
  openQuestions?: number;
  /** The review that put it in `state`; set for the three review states. */
  reviewId?: string;
}

/** One formal review waiting on the caller's decision. */
export interface MyWorkReview {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  /** Display name of the user who requested the review. */
  requestedBy: string;
  /** ISO time the caller was asked to decide. */
  since: string;
}

export interface MyWorkResponse {
  changeRequests: MyWorkChangeRequest[];
  reviews: MyWorkReview[];
  /**
   * Projects the caller can open. Lets an empty Home offer "New project" (none)
   * or "New change request" without a second request.
   */
  projectCount: number;
}
