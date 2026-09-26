"use client";

/**
 * Epic #128 / #142 — everything a page that drives a chat turn needs to show
 * the turn's tool calls and ANSWER their approval prompts:
 *
 *   • the live list of tool calls (fed by the turn's `tool_event` SSE frames via
 *     {@link ToolApprovals.apply}, AND by the session's socket room, which this
 *     hook joins — so a prompt still arrives when the page's stream did not
 *     carry it);
 *   • {@link ToolApprovals.decide}, which sends the owner's Approve / Deny.
 *
 * Every page that sends a turn on a session that can be offered tools uses
 * this (Chat and Workbench), so a prompt is never raised where nobody can
 * answer it. Render with `ToolActivityList` from `@/components/chat/tool-activity`.
 */
import { useCallback, useState } from "react";
import type { AiToolEvent } from "@metis/shared";
import { decideToolApproval } from "@/lib/ai-client";
import { applyToolEvent, type ToolActivity } from "@/lib/tool-activity";
import { useSessionToolEvents } from "@/hooks/use-session-tool-events";

export const APPROVAL_GONE_MESSAGE =
  "That approval is no longer pending — it was answered or it expired.";

export interface ToolApprovals {
  items: ToolActivity[];
  /** Approval ids with an answer in flight (their buttons are disabled). */
  deciding: ReadonlySet<string>;
  /** Fold one `tool_event` (from the SSE stream) into the list. */
  apply: (event: AiToolEvent) => void;
  /** Clear the list (a new turn, or another session). */
  reset: () => void;
  /** Send the owner's answer for one pending call. */
  decide: (item: ToolActivity, decision: "approve" | "deny") => Promise<void>;
}

export function useToolApprovals(
  sessionId: string | null,
  onError: (message: string) => void,
): ToolApprovals {
  const [items, setItems] = useState<ToolActivity[]>([]);
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());

  const apply = useCallback((ev: AiToolEvent) => {
    setItems((prev) => applyToolEvent(prev, ev));
  }, []);
  const reset = useCallback(() => setItems([]), []);

  // The session room carries the same events — and reaches a turn sent through
  // the non-streaming route, or a page that reconnected mid-turn.
  useSessionToolEvents(sessionId, apply);

  const decide = useCallback(
    async (item: ToolActivity, decision: "approve" | "deny") => {
      if (!sessionId || !item.approvalId) return;
      const approvalId = item.approvalId;
      setDeciding((prev) => new Set(prev).add(approvalId));
      try {
        // The server applies it only to a pending approval of THIS session; a
        // 404 means it lapsed or was already answered.
        await decideToolApproval(sessionId, approvalId, decision);
      } catch {
        onError(APPROVAL_GONE_MESSAGE);
      } finally {
        setDeciding((prev) => {
          const next = new Set(prev);
          next.delete(approvalId);
          return next;
        });
      }
    },
    [sessionId, onError],
  );

  return { items, deciding, apply, reset, decide };
}
