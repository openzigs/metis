/**
 * Epic #260 (#83) — per-invocation audit row.
 *
 * Persists SOC 2-relevant context for every custom-agent playground
 * invocation: who (actor), which agent, which project, timestamp (the audit
 * service stamps `createdAt`), and outcome. Reuses the existing
 * {@link audit} infrastructure — no new table, no new write path.
 */
import { audit } from "../audit/audit-service.js";
import type { TokenUsage } from "../ai/types.js";

export type InvocationOutcome = "success" | "error" | "denied";

export interface InvocationAuditInput {
  actorId: string | null;
  agentId: string;
  projectId: string;
  outcome: InvocationOutcome;
  usage?: TokenUsage;
  /** Failure reason — only meaningful when `outcome === "error"`. */
  error?: string;
}

/**
 * Record one invocation audit row. Fire-and-forget: returns immediately, the
 * underlying audit service queues the durable write.
 */
export function auditInvocation(input: InvocationAuditInput): void {
  const metadata: Record<string, unknown> = {
    projectId: input.projectId,
    outcome: input.outcome,
  };
  if (input.usage) {
    // These carried `*Usage` names until #1268 — renamed purely to dodge the
    // audit redactor's `/token/i` pattern, which blanked every count. The
    // redactor now exempts enumerated numeric counts, so the audit row uses the
    // same field names as the rest of the repo.
    metadata.promptTokens = input.usage.promptTokens;
    metadata.completionTokens = input.usage.completionTokens;
    metadata.totalTokens = input.usage.totalTokens;
  }
  if ((input.outcome === "error" || input.outcome === "denied") && input.error) {
    metadata.error = input.error;
  }

  // Denied attempts get their own action so SOC 2 reporting can isolate
  // unauthorized access attempts from ordinary success/error invocations.
  const action = input.outcome === "denied" ? "custom_agent.invoke_denied" : "custom_agent.invoked";

  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action,
    target: { type: "custom_agent", id: input.agentId },
    metadata,
  });
}
