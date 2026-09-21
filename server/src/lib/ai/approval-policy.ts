/**
 * Approval policy + audit (Phase 4 / issues #35, #36).
 *
 * The policy maps risk → action:
 *   • `auto`           — allow without prompting
 *   • `prompt-once`    — first invocation of a tool prompts; subsequent ones
 *                         in the same session are remembered
 *   • `always-prompt`  — every invocation prompts the user
 *   • `deny`           — never allow
 *
 * `ApprovalGateService` consults the per-session policy, asks the prompter
 * implementation when interaction is required, and writes one
 * `AIToolApproval` row per decision so the audit trail is complete (#36).
 */
import crypto from "node:crypto";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { ApprovalGate } from "./tool-registry.js";
import {
  type ApprovalDecision,
  type ApprovalPolicy,
  DEFAULT_APPROVAL_POLICY,
  type RiskLevel,
  type RiskPolicy,
} from "./types.js";

const log = createChildLogger("ai-approval");

const RISK_KEYS = ["low", "medium", "high"] as const;
const POLICY_KEYS = ["auto", "prompt-once", "always-prompt", "deny"] as const;

export const isValidPolicy = (value: unknown): value is RiskPolicy =>
  typeof value === "string" && (POLICY_KEYS as readonly string[]).includes(value);

export const isValidRisk = (value: unknown): value is RiskLevel =>
  typeof value === "string" && (RISK_KEYS as readonly string[]).includes(value);

/**
 * Validate + normalise an arbitrary candidate policy. Anything missing falls
 * back to {@link DEFAULT_APPROVAL_POLICY} so a malformed DB row never crashes
 * a chat session.
 */
export function normalizePolicy(input: unknown): ApprovalPolicy {
  if (!input || typeof input !== "object") return { ...DEFAULT_APPROVAL_POLICY };
  const cand = input as Record<string, unknown>;
  return {
    low: isValidPolicy(cand.low) ? cand.low : DEFAULT_APPROVAL_POLICY.low,
    medium: isValidPolicy(cand.medium) ? cand.medium : DEFAULT_APPROVAL_POLICY.medium,
    high: isValidPolicy(cand.high) ? cand.high : DEFAULT_APPROVAL_POLICY.high,
  };
}

/** Parse a JSON-encoded policy string from the DB. */
export function parsePolicyJson(json: string | null | undefined): ApprovalPolicy {
  if (!json) return { ...DEFAULT_APPROVAL_POLICY };
  try {
    return normalizePolicy(JSON.parse(json));
  } catch {
    return { ...DEFAULT_APPROVAL_POLICY };
  }
}

export function policyToJson(policy: ApprovalPolicy): string {
  return JSON.stringify(normalizePolicy(policy));
}

export interface ApprovalPrompter {
  /**
   * Ask the user to decide. Implementations resolve `true`/`false` for
   * approve/deny. Reject with a real error to surface a transport failure.
   */
  ask(input: ApprovalRequest): Promise<boolean>;
}

export interface ApprovalRequest {
  sessionId: string;
  userId: string;
  toolName: string;
  risk: RiskLevel;
  args: unknown;
}

const denyAll: ApprovalPrompter = {
  async ask() {
    return false;
  },
};

export interface ApprovalGateOptions {
  sessionId: string;
  userId: string;
  policy: ApprovalPolicy;
  prompter?: ApprovalPrompter;
  /** Persist a row to `AIToolApproval` for every decision. Defaults to `true`. */
  persist?: boolean;
}

/**
 * Per-session gate. Constructed once per chat run; tracks the
 * `prompt-once` cache for the lifetime of the session.
 */
export class ApprovalGateService implements ApprovalGate {
  private readonly opts: Required<ApprovalGateOptions>;
  private readonly remembered = new Set<string>(); // toolNames the user already approved

  constructor(opts: ApprovalGateOptions) {
    this.opts = {
      sessionId: opts.sessionId,
      userId: opts.userId,
      policy: normalizePolicy(opts.policy),
      prompter: opts.prompter ?? denyAll,
      persist: opts.persist ?? true,
    };
  }

  async decide(input: {
    sessionId: string;
    userId: string;
    toolName: string;
    risk: RiskLevel;
    args: unknown;
  }): Promise<boolean> {
    const policy = this.opts.policy[input.risk];
    const argsHash = hashArgs(input.args);

    if (policy === "auto") {
      await this.audit(input, argsHash, "auto-approve");
      return true;
    }
    if (policy === "deny") {
      await this.audit(input, argsHash, "deny", "policy=deny");
      return false;
    }
    if (policy === "prompt-once" && this.remembered.has(input.toolName)) {
      await this.audit(input, argsHash, "auto-approve", "prompt-once-cached");
      return true;
    }

    let approved: boolean;
    try {
      approved = await this.opts.prompter.ask({
        sessionId: input.sessionId,
        userId: input.userId,
        toolName: input.toolName,
        risk: input.risk,
        args: input.args,
      });
    } catch (err) {
      await this.audit(
        input,
        argsHash,
        "error",
        err instanceof Error ? err.message : "prompter_error",
      );
      return false;
    }

    if (approved && policy === "prompt-once") {
      this.remembered.add(input.toolName);
    }
    await this.audit(
      input,
      argsHash,
      approved ? "approve" : "deny",
      approved ? undefined : "user_denied",
    );
    return approved;
  }

  private async audit(
    input: {
      sessionId: string;
      userId: string;
      toolName: string;
      risk: RiskLevel;
    },
    argsHash: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    if (!this.opts.persist) return;
    try {
      await prisma.aIToolApproval.create({
        data: {
          sessionId: input.sessionId,
          userId: input.userId,
          toolName: input.toolName,
          risk: input.risk,
          decision,
          argsHash,
          reason: reason ?? null,
        },
      });
    } catch (err) {
      log.error("Approval audit write failed", {
        sessionId: input.sessionId,
        toolName: input.toolName,
        error: (err as Error).message,
      });
    }
  }
}

export function hashArgs(args: unknown): string {
  let canonical: string;
  try {
    canonical = JSON.stringify(args, sortedReplacer);
  } catch {
    canonical = String(args);
  }
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// JSON.stringify replacer that sorts object keys recursively so two equal
// argument shapes hash to the same value regardless of property order.
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {});
  }
  return value;
}
