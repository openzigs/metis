/**
 * Issue #1096 — a requirement's acceptance criteria, as derived by the analysis.
 *
 * Renders the REAL criteria when synthesis derived some, and an explicit "none
 * were derived" note when it did not. It deliberately never renders a generic
 * Given/When/Then sketch: the bug this fixes was a placeholder block that read
 * as authored criteria to anyone scanning the requirement or the issue it
 * becomes.
 */
export const NO_CRITERIA_MESSAGE =
  "No acceptance criteria were derived — add them before implementation.";

export function AcceptanceCriteriaList({ criteria }: { criteria: string[] }): React.ReactElement {
  return (
    <div className="mt-2" data-testid="acceptance-criteria">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Acceptance criteria
      </div>
      {criteria.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
          {criteria.map((c, i) => (
            <li key={`${i}-${c.slice(0, 24)}`}>{c}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm italic text-amber-300/80" data-testid="no-acceptance-criteria">
          {NO_CRITERIA_MESSAGE}
        </p>
      )}
    </div>
  );
}
