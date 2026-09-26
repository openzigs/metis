/**
 * Epic #129 (#145) — an agent's approval-policy override.
 *
 * An agent definition may carry a per-risk override. It can only TIGHTEN the
 * session's policy — the owner of the session decides how much runs without a
 * prompt, and no user-authored agent can loosen that:
 *
 *     auto  <  prompt-once  <  always-prompt  <  deny
 *
 * The effective action for each risk is the STRICTER of the two.
 */
import type { ApprovalPolicyOverride } from "@metis/shared";
import type { ApprovalPolicy, RiskPolicy } from "../ai/types.js";

const RANK: Readonly<Record<RiskPolicy, number>> = {
  auto: 0,
  "prompt-once": 1,
  "always-prompt": 2,
  deny: 3,
};
const RISKS = ["low", "medium", "high"] as const;

export class ApprovalOverrideError extends Error {}

function isAction(v: unknown): v is RiskPolicy {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(RANK, v);
}

/**
 * Validate an untrusted override (from frontmatter, a wizard or an import).
 * `null`/`undefined`/`{}` ⇒ `null` (no override). Unknown keys or values throw.
 */
export function parseApprovalOverride(input: unknown): ApprovalPolicyOverride | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ApprovalOverrideError("approvalPolicy must be an object of risk → action");
  }
  const out: ApprovalPolicyOverride = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(RISKS as readonly string[]).includes(key)) {
      throw new ApprovalOverrideError(`approvalPolicy: unknown risk level '${key.slice(0, 40)}'`);
    }
    if (!isAction(value)) {
      throw new ApprovalOverrideError(
        `approvalPolicy.${key} must be one of auto, prompt-once, always-prompt, deny`,
      );
    }
    out[key as (typeof RISKS)[number]] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Read a stored override; an unreadable row fails CLOSED to "prompt on everything". */
export function readStoredOverride(raw: string | null | undefined): ApprovalPolicyOverride | null {
  if (!raw) return null;
  try {
    return parseApprovalOverride(JSON.parse(raw));
  } catch {
    return { low: "always-prompt", medium: "always-prompt", high: "always-prompt" };
  }
}

/** The stricter of the session's policy and the agent's override, per risk. */
export function effectivePolicy(
  session: ApprovalPolicy,
  override: ApprovalPolicyOverride | null | undefined,
): ApprovalPolicy {
  if (!override) return { ...session };
  const out = { ...session };
  for (const risk of RISKS) {
    const o = override[risk];
    if (o && RANK[o] > RANK[out[risk]]) out[risk] = o;
  }
  return out;
}
