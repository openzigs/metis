/**
 * Issue #2341 (epic #2328) — the UI half of the change request's steps: where
 * each step's screen is, and the title the start form proposes.
 *
 * The steps themselves, their states and the rules that derive them
 * (`deriveChangeRequestSteps`, `ChangeRequestFacts`) live in `@metis/shared`,
 * so the server's grouping by state (#2343, #2348) reads the same rules as the
 * step header.
 */
import { CHANGE_REQUEST_TITLE_MAX, type ChangeRequestStepKey } from "@metis/shared";

/** #2345 — the id of the change request's "Impact and portfolio" card, the steps' anchor. */
export const CHANGE_REQUEST_CHECKS_ID = "change-request-checks";

/** #2345 — the newest impact analysis and portfolio check started from the change request. */
export interface LatestChecks {
  impact?: string | null;
  portfolio?: string | null;
}

/**
 * Where each step's existing screen is. #2345 — Impact and Portfolio go to the
 * newest result started from this change request, and before there is one to
 * the change request's own card that starts it: never to a global page.
 */
export function stepHref(
  key: ChangeRequestStepKey,
  projectId: string,
  analysisId: string,
  latest: LatestChecks = {},
): string {
  const p = encodeURIComponent(projectId);
  const run = (tab: string) =>
    `/projects/${p}/analysis?${new URLSearchParams({ analysisId, tab }).toString()}`;
  const checks = `/projects/${p}/analysis?${new URLSearchParams({ analysisId }).toString()}#${CHANGE_REQUEST_CHECKS_ID}`;
  switch (key) {
    case "read":
      return run("agents");
    case "questions":
      return run("questions");
    case "requirements":
      return run("requirements");
    case "policy":
      return run("findings");
    case "impact":
      return latest.impact ? `/impact-analyses/${encodeURIComponent(latest.impact)}` : checks;
    case "portfolio":
      return latest.portfolio ? `/portfolio/${encodeURIComponent(latest.portfolio)}` : checks;
    case "review":
      return `/projects/${p}/requirements`;
    case "handoff":
      return `/projects/${p}/publish?${new URLSearchParams({ analysisId }).toString()}`;
  }
}

/**
 * #2341 — the title the form proposes: the first chosen document's name (its
 * source title, else the filename), with how many more were chosen. Empty when
 * none is chosen: the server then names it after the first imported item.
 */
export function proposedChangeRequestTitle(
  selected: readonly string[],
  docs: ReadonlyArray<{ id: string; filename: string; title?: string | null }>,
): string {
  const first = docs.find((d) => d.id === selected[0]);
  if (!first) return "";
  // One line of plain text, within the limit the server checks: a filename may
  // hold control characters (the server refuses them) and may be any length.
  // The same class `clampTitle` strips on the server.
  const name = (first.title?.trim() || first.filename)
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim();
  if (!name) return "";
  const more = selected.length - 1;
  const suffix = more > 0 ? ` and ${more} more` : "";
  return `${name.slice(0, CHANGE_REQUEST_TITLE_MAX - suffix.length)}${suffix}`;
}
