/**
 * Epic #128 / #142 — answer a pending chat tool approval.
 *
 *   POST /api/ai/sessions/:id/approvals/:approvalId   { decision: "approve" | "deny" }
 *   GET  /api/ai/sessions/:id/approvals/pending
 *
 * Authorisation is the session's own rule (`loadAuthorizedSession`): the caller
 * must own the session AND still reach its project. The broker then applies the
 * decision only to an approval issued for THAT session, THAT user and THAT
 * project, still pending and not expired — and removes it as it does, so a
 * decision cannot be replayed. Every refusal answers the same 404, so a probe
 * cannot tell "another user's approval", "already decided", "expired" and "no
 * such id" apart. Both outcomes are audited.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PendingToolApprovalDto } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { conversationRateLimiter } from "../middleware/conversation-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import { loadAuthorizedSession } from "../lib/ai/conversation/session-access.js";
import { getToolApprovalBroker } from "../lib/ai/tool-runtime/approval-broker.js";

export const TOOL_APPROVAL_NOT_FOUND = "AI_TOOL_APPROVAL_NOT_FOUND";

const decisionSchema = z.object({ decision: z.enum(["approve", "deny"]) }).strict();
const APPROVAL_ID = /^apr_[0-9a-f-]{36}$/;

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function toolApprovalsRouter(): Router {
  const r = Router();

  r.post(
    "/sessions/:id/approvals/:approvalId",
    requireAuth,
    conversationRateLimiter,
    async (req: Request, res: Response) => {
      const parsed = decisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "decision must be approve or deny");
      }
      const session = await loadAuthorizedSession(req.user, String(req.params.id));
      const approvalId = String(req.params.approvalId);
      const userId = req.user!.userId;
      const outcome = APPROVAL_ID.test(approvalId)
        ? getToolApprovalBroker().decide({
            approvalId,
            sessionId: session.id,
            userId,
            projectId: session.projectId,
            answer: parsed.data.decision,
          })
        : ({ ok: false, reason: "not_found" } as const);
      audit({
        actor: { id: userId },
        action: "ai.tool.approval.decide",
        target: { type: "ai_session", id: session.id },
        metadata: {
          approvalId: approvalId.slice(0, 64),
          decision: parsed.data.decision,
          applied: outcome.ok,
          ...(outcome.ok ? {} : { refusal: outcome.reason }),
        },
      });
      if (!outcome.ok) {
        throw new AppError(404, TOOL_APPROVAL_NOT_FOUND, "No pending approval with that id");
      }
      res.json(ok({ approvalId, decision: outcome.answer }));
    },
  );

  r.get(
    "/sessions/:id/approvals/pending",
    requireAuth,
    conversationRateLimiter,
    async (req: Request, res: Response) => {
      const session = await loadAuthorizedSession(req.user, String(req.params.id));
      const items: PendingToolApprovalDto[] = getToolApprovalBroker().listPending(
        session.id,
        req.user!.userId,
      );
      res.json(ok({ items }));
    },
  );

  return r;
}
