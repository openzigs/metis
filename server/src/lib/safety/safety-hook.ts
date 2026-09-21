/**
 * Safety hook interface (Epic #164).
 *
 * Two implementations live alongside this file:
 *   - `bedrock-guardrails.ts` — calls AWS Bedrock `ApplyGuardrail` for
 *     projects whose AI provider is `bedrock-gateway`.
 *   - `regex-blocklist.ts` — fallback that runs prompt-injection +
 *     PII detection regexes for every other provider.
 *
 * `applySafety()` (in `apply-safety.ts`) chooses the right hook for a
 * project, persists a `SafetyEvent` row, and either returns the (possibly
 * redacted) text or throws `SafetyDeniedError`.
 */
import type { SafetyDirection, SafetyFinding, SafetyMode } from "@metis/shared";

export interface SafetyContext {
  projectId: string;
  sessionId: string | null;
  /** Project safety mode at the time of the call. */
  mode: SafetyMode;
}

export interface SafetyResult {
  /** True when text passed all checks (possibly after redaction). */
  allowed: boolean;
  /** When set, callers MUST forward this rewritten string to the model. */
  redacted?: string;
  /** All detected findings, regardless of verdict. */
  findings: SafetyFinding[];
}

export interface SafetyHook {
  readonly name: string;
  applyInput(text: string, ctx: SafetyContext): Promise<SafetyResult>;
  applyOutput(text: string, ctx: SafetyContext): Promise<SafetyResult>;
}

/** Thrown by `applySafety` when verdict === "blocked". HTTP status 422. */
export class SafetyDeniedError extends Error {
  readonly status = 422;
  readonly code = "SAFETY_DENIED";
  readonly findings: SafetyFinding[];
  readonly direction: SafetyDirection;
  constructor(direction: SafetyDirection, findings: SafetyFinding[]) {
    super(`Safety hook blocked ${direction} text`);
    this.name = "SafetyDeniedError";
    this.findings = findings;
    this.direction = direction;
  }
}
