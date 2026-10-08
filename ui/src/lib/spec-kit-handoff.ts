/**
 * #789 — "Start analysis with these artifacts" after `/speckit.implement`.
 *
 * The analysis run takes free-text `extraInstructions` (the requirements to
 * evaluate against the code), capped at `MAX_EXTRA_INSTRUCTIONS`. The handoff
 * sends the scope's `spec.md`, which holds those requirements, under a header
 * naming every artifact `/speckit.implement` forwarded. A spec that does not
 * fit is cut, and the caller is told so (#1101: never trim in silence).
 */
import { MAX_EXTRA_INSTRUCTIONS } from "@metis/shared";

export interface HandoffInstructions {
  text: string;
  truncated: boolean;
}

export function buildHandoffInstructions(
  context: string[],
  spec: string | null,
): HandoffInstructions {
  const header = [
    `Spec Kit handoff (${context.join(", ")}).`,
    "Evaluate the requirements in this spec.md against the current implementation.",
  ].join(" ");
  const full = spec && spec.trim().length > 0 ? `${header}\n\n${spec.trim()}` : header;
  if (full.length <= MAX_EXTRA_INSTRUCTIONS) return { text: full, truncated: false };
  return { text: full.slice(0, MAX_EXTRA_INSTRUCTIONS), truncated: true };
}
