/**
 * Issue #1615 — the projects of a multi-project impact run that have nothing to
 * show: checked with nothing affected, not checked (with the reason), or failed
 * (#1609 `projectOutcomes`). Without this a zero-hit project and a project the
 * run never searched both read as an empty section, and an analyst cannot tell
 * "this project is safe" from "nobody looked".
 *
 * A `restricted` project carries only its id (the starter could not access it),
 * so it is rendered with no name and no id: nothing about it beyond the fact
 * that it was not checked.
 */
"use client";

import type { ImpactProjectOutcome } from "@metis/shared";

const NOT_CHECKED_REASON: Record<string, string> = {
  restricted: "no access",
  "no-index": "no code index",
  timeout: "timed out",
  budget: "cost limit reached",
};

/** The status line for one project's outcome. */
export function impactOutcomeLabel(o: ImpactProjectOutcome): string {
  switch (o.outcome) {
    case "checked-none-affected":
      return "Checked: nothing affected";
    case "not-checked": {
      const reason = o.reason && Object.hasOwn(NOT_CHECKED_REASON, o.reason) ? o.reason : null;
      return reason ? `Not checked: ${NOT_CHECKED_REASON[reason]}` : "Not checked";
    }
    case "error":
      return "Error: the check failed";
    default:
      return "Outcome not recorded";
  }
}

/** Ids of the projects whose outcome is anything but `affected`. */
export function quietProjectIds(
  outcomes: readonly ImpactProjectOutcome[] | undefined,
): Set<string> {
  return new Set((outcomes ?? []).filter((o) => o.outcome !== "affected").map((o) => o.projectId));
}

function isRestricted(o: ImpactProjectOutcome): boolean {
  return o.outcome === "not-checked" && o.reason === "restricted";
}

export function ImpactProjectOutcomesGroup({
  outcomes,
  projectName,
}: {
  outcomes: readonly ImpactProjectOutcome[] | undefined;
  projectName: (projectId: string) => string;
}): React.ReactElement | null {
  const quiet = (outcomes ?? []).filter((o) => o.outcome !== "affected");
  if (quiet.length === 0) return null;
  return (
    <details
      className="rounded border border-border p-3 text-sm"
      data-testid="impact-project-outcomes"
    >
      <summary className="cursor-pointer font-medium">
        Not affected or not checked ({quiet.length} {quiet.length === 1 ? "project" : "projects"})
      </summary>
      <ul className="mt-2 space-y-1">
        {quiet.map((o, idx) => {
          const restricted = isRestricted(o);
          return (
            <li
              // A restricted project's id stays out of the DOM, so its key is positional.
              key={restricted ? `restricted-${idx}` : o.projectId}
              data-testid="impact-project-outcome"
              data-outcome={o.outcome}
              className="text-muted-foreground"
            >
              <span className="font-medium text-foreground">
                {restricted ? "A project you cannot access" : projectName(o.projectId)}
              </span>
              {" — "}
              {impactOutcomeLabel(o)}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
