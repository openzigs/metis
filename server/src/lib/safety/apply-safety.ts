/**
 * `applySafety` — single entry point used by the AI/chat path and the
 * autopilot runner.
 *
 *   1. Load the project's `safetyMode` (cached during a single request).
 *   2. Pick the right hook for the project's AI provider:
 *        - `bedrock-gateway` → BedrockGuardrailSafetyHook (with regex fallback)
 *        - everything else  → RegexBlocklistSafetyHook
 *   3. Persist the verdict + findings as a `SafetyEvent` row.
 *   4. Return the (possibly redacted) text or throw `SafetyDeniedError`.
 *
 * The Bedrock hook is run first; if it has no guardrail configured AND
 * returned no findings, we run the regex fallback as a second pass so a
 * partly-configured Bedrock deployment still gets injection protection.
 */
import type { SafetyDirection } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { BedrockGuardrailSafetyHook } from "./bedrock-guardrails.js";
import { getRegexSafetyHook } from "./regex-blocklist.js";
import {
  SafetyDeniedError,
  type SafetyContext,
  type SafetyHook,
  type SafetyResult,
} from "./safety-hook.js";

const log = createChildLogger("safety");

interface ApplySafetyOptions {
  projectId: string;
  sessionId: string | null;
  /** AI provider key — drives hook selection. */
  provider: string;
  /** Project safety mode resolved by the caller. */
  mode: SafetyContext["mode"];
  /** Direction — input prompt or model completion. */
  direction: SafetyDirection;
  /** Override the Bedrock hook (tests). */
  bedrockHook?: SafetyHook;
  /** Override the regex hook (tests). */
  regexHook?: SafetyHook;
  /** When true, skip durable persistence (used by callers that batch). */
  skipPersist?: boolean;
}

/**
 * Result returned to callers. `text` is the redacted output (equal to the
 * original when no redaction occurred). Throws `SafetyDeniedError` when the
 * hook chain reaches a "blocked" verdict.
 */
export interface ApplySafetyResult {
  text: string;
  redacted: boolean;
  findings: SafetyResult["findings"];
}

export async function applySafety(
  text: string,
  opts: ApplySafetyOptions,
): Promise<ApplySafetyResult> {
  const ctx: SafetyContext = {
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    mode: opts.mode,
  };

  if (opts.mode === "off") {
    return { text, redacted: false, findings: [] };
  }

  let result: SafetyResult;
  if (opts.provider === "bedrock-gateway") {
    const bedrock = opts.bedrockHook ?? new BedrockGuardrailSafetyHook();
    result =
      opts.direction === "input"
        ? await bedrock.applyInput(text, ctx)
        : await bedrock.applyOutput(text, ctx);
    // If Bedrock returned a definitive verdict (blocked/redacted), use it.
    // Otherwise fall through to regex for defense-in-depth.
    if (!result.allowed || result.redacted || result.findings.length > 0) {
      // already actionable
    } else {
      const regex = opts.regexHook ?? getRegexSafetyHook();
      result =
        opts.direction === "input"
          ? await regex.applyInput(text, ctx)
          : await regex.applyOutput(text, ctx);
    }
  } else {
    const regex = opts.regexHook ?? getRegexSafetyHook();
    result =
      opts.direction === "input"
        ? await regex.applyInput(text, ctx)
        : await regex.applyOutput(text, ctx);
  }

  const verdict: "allowed" | "blocked" | "redacted" = !result.allowed
    ? "blocked"
    : result.redacted
      ? "redacted"
      : "allowed";

  if (!opts.skipPersist) {
    // Persist asynchronously — never block the chat path on the audit row.
    // Errors are logged but never surface.
    void persistEvent({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      direction: opts.direction,
      verdict,
      findings: result.findings,
    });
  }

  if (!result.allowed) {
    throw new SafetyDeniedError(opts.direction, result.findings);
  }
  return {
    text: result.redacted ?? text,
    redacted: Boolean(result.redacted),
    findings: result.findings,
  };
}

async function persistEvent(input: {
  projectId: string;
  sessionId: string | null;
  direction: SafetyDirection;
  verdict: "allowed" | "blocked" | "redacted";
  findings: SafetyResult["findings"];
}): Promise<void> {
  try {
    await prisma.safetyEvent.create({
      data: {
        projectId: input.projectId,
        sessionId: input.sessionId,
        direction: input.direction,
        verdict: input.verdict,
        findings: JSON.stringify(input.findings),
      },
    });
  } catch (err) {
    log.error("SafetyEvent persist failed", {
      projectId: input.projectId,
      direction: input.direction,
      verdict: input.verdict,
      error: (err as Error).message,
    });
  }
}

export { SafetyDeniedError };
