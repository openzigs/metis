/**
 * #2348 — Home "My work": the API call and the pure helpers its view uses.
 *
 * The server (`GET /api/me/work`, `server/src/lib/my-work/my-work-service.ts`)
 * decides each change request's state; this module only groups, links and
 * words what it returns.
 */
import {
  MY_WORK_STATES,
  MY_WORK_STATE_LABELS,
  type MyWorkChangeRequest,
  type MyWorkResponse,
  type MyWorkState,
} from "@metis/shared";
import { apiFetch } from "@/lib/api-client";
import { timeAgo } from "@/lib/time-ago";

export const myWorkApi = {
  get(): Promise<MyWorkResponse> {
    return apiFetch<MyWorkResponse>("/me/work");
  },
};

export const myWorkQueryKey = ["me", "work"] as const;

export interface MyWorkGroup {
  state: MyWorkState;
  label: string;
  items: MyWorkChangeRequest[];
}

/** Change requests grouped in the fixed state order; empty groups are omitted. */
export function groupChangeRequests(items: readonly MyWorkChangeRequest[]): MyWorkGroup[] {
  return MY_WORK_STATES.map((state) => ({
    state,
    label: MY_WORK_STATE_LABELS[state],
    items: items.filter((i) => i.state === state),
  })).filter((g) => g.items.length > 0);
}

const enc = encodeURIComponent;

/** Where a change request row opens: the step its state is about. */
export function changeRequestHref(item: MyWorkChangeRequest): string {
  const run = `/projects/${enc(item.projectId)}`;
  switch (item.state) {
    case "waiting_on_me":
      return `${run}/analysis?analysisId=${enc(item.id)}&tab=questions`;
    case "ready_to_hand_off":
      return `${run}/publish?analysisId=${enc(item.id)}`;
    default:
      // In review / rejected: the review that decides it. A row without one
      // (never sent by the server today) falls back to the run itself.
      return item.reviewId
        ? `/reviews/${enc(item.reviewId)}`
        : `${run}/analysis?analysisId=${enc(item.id)}`;
  }
}

/** "for 3d", "for 5h", "for under a minute": how long it has been in its state. */
export function timeInState(since: string, now: number = Date.now()): string {
  const ago = timeAgo(since, now);
  if (!ago) return "";
  return ago === "just now" ? "for under a minute" : `for ${ago.replace(/ ago$/, "")}`;
}
