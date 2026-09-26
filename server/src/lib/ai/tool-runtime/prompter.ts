/**
 * Epic #128 / #142 — the approval prompter chat uses: register a pending
 * approval with the broker, tell the user (an `awaiting_approval` tool event on
 * the SSE stream and in the session's socket room), and wait for the answer.
 *
 * No model call is in flight while it waits — the tool loop only asks between
 * provider calls, so a local-model concurrency slot is never held across a
 * human decision.
 */
import type { ApprovalPrompter, PrompterAnswer } from "../approval-policy.js";
import type { ToolApprovalBroker } from "./approval-broker.js";
import type { RuntimeToolset } from "./toolset.js";
import { preview, type ToolEvent } from "./types.js";

export interface BrokerPrompterOptions {
  broker: ToolApprovalBroker;
  toolset: RuntimeToolset;
  projectId: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: ToolEvent) => void;
}

export function brokerPrompter(opts: BrokerPrompterOptions): ApprovalPrompter {
  return {
    async ask(req): Promise<PrompterAnswer> {
      const tool = opts.toolset.resolve(req.toolName);
      return opts.broker.request(
        {
          sessionId: req.sessionId,
          userId: req.userId,
          projectId: opts.projectId,
          toolName: req.toolName,
          argsHash: req.argsHash ?? "",
          ...(req.callId ? { callId: req.callId } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (ticket) => {
          let argsText: string;
          try {
            argsText = JSON.stringify(req.args ?? null) ?? "null";
          } catch {
            argsText = String(req.args);
          }
          opts.onEvent?.({
            type: "tool_event",
            phase: "awaiting_approval",
            sessionId: req.sessionId,
            callId: req.callId ?? ticket.approvalId,
            name: req.toolName,
            risk: req.risk,
            source: tool?.source ?? null,
            argsPreview: preview(argsText),
            approvalId: ticket.approvalId,
            expiresAt: new Date(ticket.expiresAt).toISOString(),
            ts: Date.now(),
          });
        },
      );
    },
  };
}
