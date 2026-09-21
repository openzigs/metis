/**
 * Epic #165 (#121) — Plan-mode state machine.
 *
 * Persists per-session plans and gates execution while one is `pending`. The
 * orchestrator calls `recordPendingPlan` after the BA + Architect specialists
 * emit a plan; the API surface (`POST /api/ai/sessions/:id/approve-plan`)
 * calls `decidePlan` and the chat UI surfaces the result.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import type { SdkPlanStatus, SessionPlanDto } from "@metis/shared";

export class PlanStateError extends Error {}

interface PlanRow {
  id: string;
  sessionId: string;
  planText: string;
  status: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: PlanRow): SessionPlanDto {
  return {
    id: r.id,
    sessionId: r.sessionId,
    planText: r.planText,
    status: r.status as SdkPlanStatus,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decidedBy: r.decidedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function recordPendingPlan(
  sessionId: string,
  planText: string,
): Promise<SessionPlanDto> {
  if (planText.trim().length === 0) {
    throw new PlanStateError("Plan text must not be empty");
  }
  const existing = await prisma.sessionPlan.findFirst({
    where: { sessionId, status: "pending" },
  });
  if (existing) {
    throw new PlanStateError("A plan is already pending for this session");
  }
  await prisma.aISession.update({
    where: { id: sessionId },
    data: { planModeActive: true },
  });
  const row = await prisma.sessionPlan.create({
    data: { sessionId, planText, status: "pending" },
  });
  audit({
    action: "session.plan.created",
    target: { type: "session_plan", id: row.id },
    metadata: { sessionId },
  });
  return toDto(row);
}

export async function getCurrentPlan(sessionId: string): Promise<SessionPlanDto | null> {
  const row = await prisma.sessionPlan.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
  });
  return row ? toDto(row) : null;
}

export async function decidePlan(
  planId: string,
  decision: "approved" | "rejected",
  decidedBy?: string,
): Promise<SessionPlanDto> {
  const row = await prisma.sessionPlan.findUnique({ where: { id: planId } });
  if (!row) throw new PlanStateError("Plan not found");
  if (row.status !== "pending") {
    throw new PlanStateError(`Plan already ${row.status}`);
  }
  const updated = await prisma.sessionPlan.update({
    where: { id: planId },
    data: {
      status: decision,
      decidedAt: new Date(),
      decidedBy: decidedBy ?? null,
    },
  });
  // Once approved or rejected, exit plan-mode.
  await prisma.aISession.update({
    where: { id: row.sessionId },
    data: { planModeActive: false },
  });
  audit({
    actor: decidedBy ? { id: decidedBy } : null,
    action: `session.plan.${decision}`,
    target: { type: "session_plan", id: row.id },
    metadata: { sessionId: row.sessionId },
  });
  return toDto(updated);
}

/**
 * Activate plan mode at session start when `Project.planModeRequired` is true
 * (or always when the caller explicitly opts in). The orchestrator is
 * responsible for emitting the plan text via {@link recordPendingPlan}.
 */
export async function activatePlanMode(sessionId: string): Promise<void> {
  await prisma.aISession.update({
    where: { id: sessionId },
    data: { planModeActive: true },
  });
}
