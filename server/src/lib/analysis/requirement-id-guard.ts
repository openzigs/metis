/**
 * Issue #1027 (review) — a code finding may name only a requirement of its run.
 *
 * The code agent's prompt holds text that carries other id-like labels: a plan
 * context's task ids (`T01`) and component names, and any `- [NR-9] …` line an
 * author wrote into a document or a plan. The prompt tells the model never to
 * write one as a `requirementId`, but a prompt is not enforcement, so the id is
 * checked here against the requirement set the run actually has. An id outside
 * that set is cleared; the finding itself is kept.
 *
 * The set is the RUN's code requirements (document-extracted `REQ-*` merged
 * with the operator's `NR-*`), not one pass's slice of them, so a finding in a
 * split deep/standard pass that names a requirement of the other pass keeps
 * its id. A single-shot code pass has no requirement set at all (that is what
 * makes it single-shot) and its prompt neither lists requirement ids nor asks
 * for the field, so every id it writes is cleared.
 */
export interface RequirementIdGuardResult<T> {
  findings: T[];
  /** How many findings had a `requirementId` cleared. */
  cleared: number;
}

export function clearUnknownRequirementIds<T extends { requirementId?: string | null }>(
  findings: readonly T[],
  knownRequirementIds: ReadonlySet<string>,
): RequirementIdGuardResult<T> {
  let cleared = 0;
  const guarded = findings.map((finding) => {
    const id = finding.requirementId;
    if (id === undefined || id === null || knownRequirementIds.has(id)) return finding;
    cleared += 1;
    return { ...finding, requirementId: null };
  });
  return { findings: guarded, cleared };
}
