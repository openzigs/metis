/** #1471 — what an unpriced model under a monthly limit means, and what to do. */
export const PR_REVIEW_UNPRICED_LIMIT_TEXT =
  "This project’s AI model has no price, so the monthly limit cannot count what reviews spend, and pull requests are not being reviewed. Give the model a price in the MODEL_PRICES setting, or remove the limit.";

/**
 * #1478 — whether a monthly PR-review limit is set. The server reads a cap of
 * 0 as no limit (`checkBudget`, the `budget_unpriced` refusal), so the UI must
 * too, or it warns about a limit that limits nothing.
 */
export function prReviewLimitIsSet(capCents: number | null | undefined): capCents is number {
  return typeof capCents === "number" && capCents > 0;
}
