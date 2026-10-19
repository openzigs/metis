/**
 * #999 / #1230 — which analysis run's requirements are "the project's
 * requirements" when nobody has chosen a run.
 *
 * Requirements belong to the run that produced them, and a re-run writes a new
 * set, so every reader has to pick ONE run. The Requirements hub opens on the
 * run this returns, and a reader-layout BRD's Approved Requirements section
 * (#1218) reads the same run, so the two never disagree about which
 * requirements are current.
 */

/** What the choice needs to know about each run. */
export interface RequirementsRunCandidate {
  id: string;
  status: string;
  /** The run's live requirements, whatever their review status. */
  requirementCount: number;
  /**
   * #1252 — when the run last finished. A run `running` with this set is a
   * re-opened one (a regenerate or a repo resume), which counts as completed.
   */
  completedAt?: string | Date | null;
}

/**
 * #1252 — whether a run counts as completed for the choice: completed, or
 * re-opened by a regenerate or a repo resume (`running` again, with the
 * `completedAt` of its earlier finish). A re-run rewrites its requirements and
 * settles again within minutes; leaving it out for that window moved the
 * default to an older run, so every reader saw that run's requirements
 * meanwhile. A first run still running has no `completedAt`, and is not
 * counted until it completes; nor is a failed or cancelled run being re-run,
 * whose `completedAt` the server clears when it re-opens it
 * (`markAnalysisRunning`), since it never completed.
 *
 * Known gap: a re-run whose process dies before it settles stays `running`
 * with its `completedAt`, and so stays the default, until it is settled.
 */
export function countsAsCompletedRun(
  run: Pick<RequirementsRunCandidate, "status" | "completedAt">,
) {
  return run.status === "completed" || (run.status === "running" && run.completedAt != null);
}

/**
 * The newest completed run that has any requirements, else the newest
 * completed run; `null` when no run has completed. `runs` is newest first.
 * A run whose requirements are all still draft counts: it is the current set,
 * and its approvals are the ones that count. A re-opened run counts as
 * completed ({@link countsAsCompletedRun}).
 */
export function defaultRequirementsRunId(runs: readonly RequirementsRunCandidate[]): string | null {
  const completed = runs.filter(countsAsCompletedRun);
  return (completed.find((r) => r.requirementCount > 0) ?? completed[0])?.id ?? null;
}
