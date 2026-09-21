/**
 * P0 #774 — self-repairable tool-argument rejections.
 *
 * A rejection the model cannot act on is worse than no rejection: on the #773
 * run the model re-emitted the SAME (correct) query every turn because
 * "Error: query is required" never told it what had actually arrived, and the
 * whole turn budget burned in a self-inflicted error loop.
 *
 * Every rejection produced here names:
 *   - the tool and the parameter that is missing (with its expected type),
 *   - the keys the tool ACTUALLY received, and
 *   - the exact JSON shape of a correct call.
 *
 * Received keys are echoed by NAME only — never their values — so an untrusted
 * argument value can never be reflected back into the conversation, and the
 * message length stays bounded regardless of what the model sent.
 */

/** Cap the echoed key list so a pathological object cannot blow the context. */
const MAX_ECHOED_KEYS = 12;
const MAX_KEY_CHARS = 40;

/** Render the keys an object carries, bounded and value-free. */
export function describeReceivedKeys(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "received keys: []";
  const keys = Object.keys(args as Record<string, unknown>);
  const shown = keys
    .slice(0, MAX_ECHOED_KEYS)
    .map((k) => (k.length > MAX_KEY_CHARS ? `${k.slice(0, MAX_KEY_CHARS)}…` : k));
  const suffix = keys.length > MAX_ECHOED_KEYS ? `, …+${keys.length - MAX_ECHOED_KEYS} more` : "";
  return `received keys: [${shown.join(", ")}${suffix}]`;
}

export interface MissingParamErrorInput {
  /** The tool that is rejecting the call. */
  tool: string;
  /** The required parameter that is missing or invalid. */
  param: string;
  /** Human description of what a valid value looks like. */
  expected: string;
  /** The args object the tool was handed. */
  args: unknown;
  /** An example value used to render the corrected call. */
  example: string;
}

/**
 * Build a rejection message the model can repair from in ONE turn.
 *
 * Note the parser (#774) already absorbs top-level/aliased args, so reaching
 * this message means the parameter genuinely never arrived — the message says
 * what did.
 */
export function missingParamError(input: MissingParamErrorInput): string {
  const example = JSON.stringify({
    tool: input.tool,
    args: { [input.param]: input.example },
  });
  return (
    `Error: ${input.tool} requires "${input.param}" (${input.expected}), ` +
    `but it was not supplied — ${describeReceivedKeys(input.args)}. ` +
    `Retry with: ${example}`
  );
}
