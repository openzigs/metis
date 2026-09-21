/**
 * Issue #104 — per-tool, per-session approval gate.
 *
 * `requestApproval(...)` registers a pending approval, broadcasts a
 * `mcp:approval:requested` Socket.IO event into the session room, and returns
 * a Promise that resolves when the UI POSTs to
 * `/api/mcp/approvals/:id/decide`. If the user does not respond within
 * `timeoutMs` (default 60s), the approval auto-resolves to `denied` — denial
 * is the safe default for an unbounded tool surface.
 *
 * The pending map is in-memory; a server restart cancels all in-flight
 * approvals (the audit row is updated to `timeout`). This is acceptable
 * because chat sessions are themselves transient.
 */
import type { MCPHiddenCharRange, MCPApprovalStatus } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { scanForHiddenChars, summarizeRanges } from "./hidden-char-scanner.js";

const log = createChildLogger("mcp-approval");

export class McpApprovalDeniedError extends Error {
  readonly code = "tool_denied";
  readonly reason: "denied" | "timeout";
  readonly approvalId: string;
  constructor(approvalId: string, reason: "denied" | "timeout", message?: string) {
    super(message ?? `MCP tool invocation ${reason}`);
    this.name = "McpApprovalDeniedError";
    this.approvalId = approvalId;
    this.reason = reason;
  }
}

export interface ApprovalRequest {
  sessionId: string;
  serverId: string;
  serverLabel: string;
  toolName: string;
  args: unknown;
  risk: "low" | "medium" | "high";
  timeoutMs?: number;
}

export interface ApprovalNotifier {
  emit(event: {
    approvalId: string;
    sessionId: string;
    serverId: string;
    serverLabel: string;
    toolName: string;
    risk: "low" | "medium" | "high";
    args: unknown;
    hiddenCharRanges: MCPHiddenCharRange[];
    timeoutMs: number;
    ts: number;
  }): void;
  emitDecision?(event: {
    approvalId: string;
    sessionId: string;
    decision: "approved" | "denied" | "timeout";
    ts: number;
  }): void;
}

interface PendingEntry {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

const pending = new Map<string, PendingEntry>();
let notifier: ApprovalNotifier | null = null;

export function setApprovalNotifier(n: ApprovalNotifier | null): void {
  notifier = n;
}

export function getPendingApprovalCount(): number {
  return pending.size;
}

/** Test-only: clear the pending map. */
export function _resetApprovalsForTests(): void {
  for (const e of pending.values()) clearTimeout(e.timer);
  pending.clear();
}

export async function requestApproval(req: ApprovalRequest): Promise<void> {
  const timeoutMs = req.timeoutMs ?? 60_000;
  const argsJson = safeStringify(req.args);
  const ranges = scanForHiddenChars(argsJson);
  const approval = await prisma.mCPToolApproval.create({
    data: {
      sessionId: req.sessionId,
      serverId: req.serverId,
      toolName: req.toolName,
      args: argsJson,
      status: "pending",
    },
  });
  notifier?.emit({
    approvalId: approval.id,
    sessionId: req.sessionId,
    serverId: req.serverId,
    serverLabel: req.serverLabel,
    toolName: req.toolName,
    risk: req.risk,
    args: req.args,
    hiddenCharRanges: ranges,
    timeoutMs,
    ts: Date.now(),
  });
  if (ranges.length > 0) {
    log.warn("MCP approval prompt contains suspicious hidden characters", {
      approvalId: approval.id,
      summary: summarizeRanges(ranges),
    });
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(approval.id);
      void finalize(approval.id, "timeout", null).catch((err) => {
        log.warn("Failed to persist approval timeout", { error: (err as Error).message });
      });
      notifier?.emitDecision?.({
        approvalId: approval.id,
        sessionId: req.sessionId,
        decision: "timeout",
        ts: Date.now(),
      });
      reject(new McpApprovalDeniedError(approval.id, "timeout"));
    }, timeoutMs);
    pending.set(approval.id, {
      sessionId: req.sessionId,
      timer,
      resolve: (approved) => {
        if (approved) resolve();
        else reject(new McpApprovalDeniedError(approval.id, "denied"));
      },
    });
  });
}

/**
 * UI calls this when the user clicks Approve / Deny in the chat-side prompt.
 * Returns the persisted status so the route handler can echo it back.
 */
export async function decideApproval(
  approvalId: string,
  decision: "approved" | "denied",
  decidedBy: string | null,
): Promise<MCPApprovalStatus> {
  const entry = pending.get(approvalId);
  if (entry) {
    pending.delete(approvalId);
    clearTimeout(entry.timer);
    entry.resolve(decision === "approved");
    notifier?.emitDecision?.({
      approvalId,
      sessionId: entry.sessionId,
      decision,
      ts: Date.now(),
    });
  }
  await finalize(approvalId, decision, decidedBy);
  return decision;
}

async function finalize(
  approvalId: string,
  status: MCPApprovalStatus,
  decidedBy: string | null,
): Promise<void> {
  await prisma.mCPToolApproval.updateMany({
    where: { id: approvalId, status: "pending" },
    data: { status, decidedAt: new Date(), decidedBy },
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}
