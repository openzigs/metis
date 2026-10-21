/**
 * Issue #1081 — the value a model step returns when its answer could not be
 * read, so "nothing was read" and "the model found nothing" stay two
 * different results all the way to the screen.
 */
import type { UnreadAnalysisStep, UnreadAnalysisStepKey } from "@metis/shared";
import type { NoVerdictReason } from "./structured-verdict.js";

/** Why one model answer could not be read. Carries no model text. */
export interface UnreadModelReply {
  reason: NoVerdictReason;
  /** Parse or provider message, for the log. Never rendered to the analyst. */
  detail: string;
}

/**
 * #1081 review — a list the model wrote that has entries but not ONE usable
 * one is not an empty answer: it is an answer METIS could not read. Used as an
 * envelope refinement, so the caller re-prompts and then reports it unread.
 * (The same rule `parseQueryList` applies to search queries.)
 */
export function noUsableItem(
  list: readonly unknown[] | null | undefined,
  usable: (item: unknown) => boolean,
): boolean {
  return !!list && list.length > 0 && !list.some(usable);
}

/** Longest slice of a model reply echoed back in a re-prompt (as `requestStructuredVerdict`). */
export const MAX_ECHOED_REPLY_CHARS = 2_000;

/** Clip a reply before it is replayed to the model, marking the cut. */
export function clipEchoedReply(raw: string): string {
  return raw.length <= MAX_ECHOED_REPLY_CHARS
    ? raw
    : `${raw.slice(0, MAX_ECHOED_REPLY_CHARS)}\n…[truncated ${raw.length - MAX_ECHOED_REPLY_CHARS} chars]`;
}

/**
 * Fold the unread replies of one step into the persisted record, or `null`
 * when every call of the step was read. The first reason is kept: it is
 * enough to word the notice, and the log has the rest.
 */
export function unreadStep(
  step: UnreadAnalysisStepKey,
  unread: readonly (UnreadModelReply | undefined)[],
  totalCalls: number,
): UnreadAnalysisStep | null {
  const failed = unread.filter((u): u is UnreadModelReply => u !== undefined);
  if (failed.length === 0) return null;
  return {
    step,
    reason: failed[0]!.reason,
    failedCalls: failed.length,
    totalCalls: Math.max(totalCalls, failed.length),
  };
}
