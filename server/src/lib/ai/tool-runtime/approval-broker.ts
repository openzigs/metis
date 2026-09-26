/**
 * Epic #128 / #142 — pending tool approvals for chat sessions.
 *
 * When the gate must ask a person, the broker registers ONE pending approval
 * under a fresh unguessable id, bound to the session, the session's owner and
 * project, the tool, and the sha256 of the exact arguments. It resolves when:
 *
 *   • the owner answers through `POST /api/ai/sessions/:id/approvals/:approvalId`
 *     (the route authorises the session first — ownership AND project access);
 *   • the request lapses (default {@link DEFAULT_APPROVAL_TIMEOUT_MS}) — `expired`,
 *     which the gate records and treats as a denial;
 *   • the turn is aborted (client disconnect / stop) — a denial.
 *
 * Every answer path is single-use: the entry is removed before it resolves, so
 * a replayed decision, a decision for another session or user, a made-up id and
 * a decision after expiry all find nothing and change nothing. Nothing a MODEL
 * writes can reach {@link ToolApprovalBroker.decide}: it is called only by the
 * authenticated HTTP route.
 *
 * The pending map is in-process, like the MCP approvals (#104): a restart
 * cancels in-flight approvals (their turns end), and a multi-replica deployment
 * needs sticky sessions for chat.
 */
import crypto from "node:crypto";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export type ApprovalAnswer = "approve" | "deny" | "expired";

export interface ApprovalTicket {
  approvalId: string;
  expiresAt: number;
}

export interface BrokerRequest {
  sessionId: string;
  userId: string;
  projectId: string | null;
  toolName: string;
  argsHash: string;
  callId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PendingApprovalView {
  approvalId: string;
  sessionId: string;
  toolName: string;
  callId: string | null;
  expiresAt: string;
}

/** Why a decision was not applied. Callers answer every one of these with 404. */
export type DecideOutcome =
  | { ok: true; answer: "approve" | "deny" }
  | { ok: false; reason: "not_found" | "expired" };

interface Entry extends Required<Omit<BrokerRequest, "signal" | "timeoutMs" | "callId">> {
  callId: string | null;
  expiresAt: number;
  settle: (answer: ApprovalAnswer) => void;
}

export class ToolApprovalBroker {
  private readonly pending = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Register a pending approval and wait for its answer. `onTicket` runs
   * synchronously with the id before this waits, so the caller can prompt the
   * user (SSE + socket) with it.
   */
  request(req: BrokerRequest, onTicket: (ticket: ApprovalTicket) => void): Promise<ApprovalAnswer> {
    const timeoutMs =
      req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
    const approvalId = `apr_${crypto.randomUUID()}`;
    const expiresAt = this.now() + timeoutMs;
    return new Promise<ApprovalAnswer>((resolve) => {
      const onAbort = (): void => settle("deny");
      const settle = (answer: ApprovalAnswer): void => {
        if (!this.pending.delete(approvalId)) return;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const timer = setTimeout(() => settle("expired"), timeoutMs);
      timer.unref?.();
      this.pending.set(approvalId, {
        sessionId: req.sessionId,
        userId: req.userId,
        projectId: req.projectId,
        toolName: req.toolName,
        argsHash: req.argsHash,
        callId: req.callId ?? null,
        expiresAt,
        settle,
      });
      if (req.signal?.aborted) {
        settle("deny");
        return;
      }
      req.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        onTicket({ approvalId, expiresAt });
      } catch {
        /* a failed notification must not strand the approval — it still lapses */
      }
    });
  }

  /**
   * Apply a person's answer. The caller MUST pass the session it authorised and
   * the authenticated user; an approval is applied only when both match the
   * ones it was issued for (and its project, when the caller passes one).
   */
  decide(input: {
    approvalId: string;
    sessionId: string;
    userId: string;
    projectId?: string | null;
    answer: "approve" | "deny";
  }): DecideOutcome {
    const entry = this.pending.get(input.approvalId);
    if (
      !entry ||
      entry.sessionId !== input.sessionId ||
      entry.userId !== input.userId ||
      (input.projectId !== undefined && entry.projectId !== input.projectId)
    ) {
      return { ok: false, reason: "not_found" };
    }
    if (this.now() >= entry.expiresAt) {
      entry.settle("expired");
      return { ok: false, reason: "expired" };
    }
    entry.settle(input.answer);
    return { ok: true, answer: input.answer };
  }

  /** The session owner's pending approvals (what a reconnecting UI re-renders). */
  listPending(sessionId: string, userId: string): PendingApprovalView[] {
    const out: PendingApprovalView[] = [];
    for (const [approvalId, e] of this.pending) {
      if (e.sessionId !== sessionId || e.userId !== userId) continue;
      out.push({
        approvalId,
        sessionId,
        toolName: e.toolName,
        callId: e.callId,
        expiresAt: new Date(e.expiresAt).toISOString(),
      });
    }
    return out;
  }

  get size(): number {
    return this.pending.size;
  }
}

let singleton: ToolApprovalBroker | null = null;

export function getToolApprovalBroker(): ToolApprovalBroker {
  if (!singleton) singleton = new ToolApprovalBroker();
  return singleton;
}

/** Test helper. */
export function __resetToolApprovalBroker(broker?: ToolApprovalBroker): void {
  singleton = broker ?? null;
}
