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

/**
 * What a prompter may answer. `true`/`false` are approve/deny (the original
 * contract); `"expired"` means nobody answered before the request lapsed, which
 * is a denial recorded as `expired` (#142: a timeout counts as deny).
 */
export type PrompterAnswer = boolean | "approve" | "deny" | "expired";

export interface ApprovalPrompter {
  /**
   * Ask the user to decide. Implementations resolve approve/deny (or
   * `"expired"`). Reject with a real error to surface a transport failure —
   * that is recorded as `error` and DENIES the call.
   */
  ask(input: ApprovalRequest): Promise<PrompterAnswer>;
}

export interface ApprovalRequest {
  sessionId: string;
  userId: string;
  toolName: string;
  risk: RiskLevel;
  args: unknown;
  /** #142 — sha256 of the canonical arguments, bound to the approval. */
  argsHash?: string;
  /** #142 — the model's tool-call id, so a UI can tie the prompt to the call. */
  callId?: string;
}

const denyAll: ApprovalPrompter = {
  async ask() {
    return false;
  },
};

/**
 * #142 — does an agent tool reference admit `name`? The forms agent files may
 * use (validated at save time by `agent-service.ts`, which rejects a bare `*`):
 * an exact tool name, or a namespace wildcard such as `mcp:*` / `mcp:<server>:*`.
 */
export function matchesToolRef(ref: string, name: string): boolean {
  if (ref === name) return true;
  if (ref.endsWith(":*")) return name.startsWith(ref.slice(0, -1));
  return false;
}

export interface ApprovalGateOptions {
  sessionId: string;
  userId: string;
  policy: ApprovalPolicy;
  prompter?: ApprovalPrompter;
  /** Persist a row to `AIToolApproval` for every decision. Defaults to `true`. */
  persist?: boolean;
  /**
   * #142 — the session agent's tool allowlist. `null`/absent: the agent declares
   * none (every offered tool is subject to the policy). Otherwise a call to a
   * tool no ref admits is REFUSED — even when its risk policy is `auto`.
   */
  agentAllowlist?: readonly string[] | null;
  /**
   * #142 — `prompt-once` is remembered per SESSION, not per gate instance (a
   * gate is built per chat turn). Answers whether this session already has a
   * person's approval on record for `toolName` at `risk`.
   */
  rememberedApproval?: (toolName: string, risk: RiskLevel) => Promise<boolean>;
}

export interface GateInput {
  sessionId: string;
  userId: string;
  toolName: string;
  risk: RiskLevel;
  args: unknown;
  /** #142 — a person must approve this call whatever the policy says. */
  forcePrompt?: boolean;
  callId?: string;
}

export interface GateResult {
  allowed: boolean;
  decision: ApprovalDecision;
  /** Machine reason for a denial (`policy=deny`, `not_in_agent_allowlist`, …). */
  reason?: string;
}

/**
 * Per-session gate. Constructed once per chat run and BOUND to its session and
 * user: a decision requested for any other session or user is refused, so a
 * gate can never be borrowed to approve somebody else's call.
 */
export class ApprovalGateService implements ApprovalGate {
  private readonly opts: Required<Omit<ApprovalGateOptions, "rememberedApproval">> &
    Pick<ApprovalGateOptions, "rememberedApproval">;
  private readonly remembered = new Set<string>(); // `${risk}:${toolName}` approved this run

  constructor(opts: ApprovalGateOptions) {
    this.opts = {
      sessionId: opts.sessionId,
      userId: opts.userId,
      policy: normalizePolicy(opts.policy),
      prompter: opts.prompter ?? denyAll,
      persist: opts.persist ?? true,
      agentAllowlist: opts.agentAllowlist ?? null,
      rememberedApproval: opts.rememberedApproval,
    };
  }

  async decide(input: {
    sessionId: string;
    userId: string;
    toolName: string;
    risk: RiskLevel;
    args: unknown;
  }): Promise<boolean> {
    return (await this.evaluate(input)).allowed;
  }

  /** #142 — the full decision, audited. Every path writes exactly one row. */
  async evaluate(input: GateInput): Promise<GateResult> {
    const argsHash = hashArgs(input.args);
    // Always audit under the gate's OWN identity, never the caller's claim.
    const bound = { ...input, sessionId: this.opts.sessionId, userId: this.opts.userId };
    const finish = async (
      allowed: boolean,
      decision: ApprovalDecision,
      reason?: string,
    ): Promise<GateResult> => {
      const recorded = await this.audit(bound, argsHash, decision, reason);
      // #142 — every approval decision is recorded. An ALLOW that could not be
      // written is refused: a tool must never run with no approval row behind
      // it. (A denial stands either way; its failed write is logged.)
      if (allowed && !recorded) {
        return { allowed: false, decision: "error", reason: "audit_write_failed" };
      }
      return { allowed, decision, ...(reason ? { reason } : {}) };
    };

    if (input.sessionId !== this.opts.sessionId || input.userId !== this.opts.userId) {
      return finish(false, "deny", "session_mismatch");
    }
    const allowlist = this.opts.agentAllowlist;
    if (allowlist && !allowlist.some((ref) => matchesToolRef(ref, input.toolName))) {
      return finish(false, "deny", "not_in_agent_allowlist");
    }
    const policy = this.opts.policy[input.risk];
    if (policy === "deny") return finish(false, "deny", "policy=deny");
    if (!input.forcePrompt) {
      if (policy === "auto") return finish(true, "auto-approve");
      if (policy === "prompt-once" && (await this.isRemembered(input.toolName, input.risk))) {
        return finish(true, "auto-approve", "prompt-once-cached");
      }
    }

    let answer: PrompterAnswer;
    try {
      answer = await this.opts.prompter.ask({
        sessionId: this.opts.sessionId,
        userId: this.opts.userId,
        toolName: input.toolName,
        risk: input.risk,
        args: input.args,
        argsHash,
        ...(input.callId ? { callId: input.callId } : {}),
      });
    } catch (err) {
      return finish(false, "error", err instanceof Error ? err.message : "prompter_error");
    }
    if (answer === "expired") return finish(false, "expired", "approval_timeout");
    const approved = answer === true || answer === "approve";
    if (!approved) return finish(false, "deny", "user_denied");
    // Only a `prompt-once` answer is tagged as one: that tag is what the
    // session memory looks up, so a forced (MCP `requireApproval`) or
    // `always-prompt` approval must never be mistaken for it later.
    const once = policy === "prompt-once" && !input.forcePrompt;
    const result = await finish(true, "approve", once ? "prompt-once" : undefined);
    // Remembered only once the approval is on record (an unrecorded one was refused).
    if (once && result.allowed) this.remembered.add(`${input.risk}:${input.toolName}`);
    return result;
  }

  private async isRemembered(toolName: string, risk: RiskLevel): Promise<boolean> {
    if (this.remembered.has(`${risk}:${toolName}`)) return true;
    if (!this.opts.rememberedApproval) return false;
    try {
      return await this.opts.rememberedApproval(toolName, risk);
    } catch {
      // Fail closed: an unreadable memory means "ask again", never "allow".
      return false;
    }
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
  ): Promise<boolean> {
    if (!this.opts.persist) return true;
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
      return true;
    } catch (err) {
      log.error("Approval audit write failed", {
        sessionId: input.sessionId,
        toolName: input.toolName,
        error: (err as Error).message,
      });
      return false;
    }
  }
}

/**
 * #142 — `prompt-once` memory backed by the audit table: a person approved this
 * tool, at this risk, earlier in THIS session, in answer to a `prompt-once`
 * prompt. Only rows the gate itself wrote count (`decision = approve`,
 * `reason = prompt-once`); an automatic approval never does, and neither does
 * an approval given under `always-prompt` or a forced MCP prompt — each of
 * those admitted one call, not the tool for the rest of the session.
 */
export function sessionApprovalMemory(
  sessionId: string,
): (toolName: string, risk: RiskLevel) => Promise<boolean> {
  return async (toolName, risk) => {
    const row = await prisma.aIToolApproval.findFirst({
      where: { sessionId, toolName, risk, decision: "approve", reason: "prompt-once" },
      select: { id: true },
    });
    return row !== null;
  };
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
