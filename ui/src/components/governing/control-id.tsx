/**
 * #2220 — a governing rule's control id, saying when METIS numbered it.
 *
 * A rule whose policy gives it no id is numbered `METIS-001`, `METIS-002`, …
 * (#1947). Listed bare, a NIST rule's "METIS-002" read like one of METIS's own
 * controls, so a generated id carries a note that the policy has none.
 */
import { isGeneratedControlId } from "@metis/shared";

export const GENERATED_CONTROL_ID_NOTE = "numbered by METIS";
export const GENERATED_CONTROL_ID_HINT =
  "The policy gives this rule no id of its own, so METIS numbered it.";

export function ControlId({ controlId, className }: { controlId: string; className?: string }) {
  return (
    <span className={className}>
      <span className="font-mono">{controlId}</span>
      {isGeneratedControlId(controlId) ? (
        <span
          className="ml-1 font-sans text-xs text-muted-foreground"
          title={GENERATED_CONTROL_ID_HINT}
          data-testid="generated-control-id"
        >
          ({GENERATED_CONTROL_ID_NOTE})
        </span>
      ) : null}
    </span>
  );
}
