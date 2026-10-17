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
}

/**
 * The newest completed run that has any requirements, else the newest
 * completed run; `null` when no run has completed. `runs` is newest first.
 * A run whose requirements are all still draft counts: it is the current set,
 * and its approvals are the ones that count.
 */
export function defaultRequirementsRunId(runs: readonly RequirementsRunCandidate[]): string | null {
  const completed = runs.filter((r) => r.status === "completed");
  return (completed.find((r) => r.requirementCount > 0) ?? completed[0])?.id ?? null;
}
