/**
 * Epic #165 (#122) — the resumable-session lists behind `GET /api/ai/sessions`.
 *
 * #202 — the client-snapshot resume helpers that used to live here
 * (`rehydrate`, `writeSnapshot`, `readSnapshot`, `shouldSnapshot`) are gone.
 * Resume reads the server transcript (`conversation/conversation-service.ts`),
 * and the session `snapshot` column is written only by `writeDerivedSnapshot`
 * (`conversation/turn.ts`), derived from that transcript. Nothing may hand a
 * client-supplied history back to a model again (#136).
 */
import { prisma } from "../prisma.js";
import type { ResumableSessionDto, SdkReasoningEffort } from "@metis/shared";

const RESUMABLE_TTL_HOURS = Number(process.env.SESSION_RESUME_TTL_HOURS ?? 24);

interface SessionListRow {
  id: string;
  projectId: string | null;
  title: string;
  model: string;
  currentModel: string | null;
  currentReasoningEffort: string | null;
  planModeActive: boolean;
  status: string;
  snapshotUpdatedAt: Date | null;
  updatedAt: Date;
}

function toListDto(r: SessionListRow): ResumableSessionDto {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    model: r.model,
    currentModel: r.currentModel,
    currentReasoningEffort: (r.currentReasoningEffort as SdkReasoningEffort | null) ?? null,
    planModeActive: r.planModeActive,
    status: r.status,
    snapshotUpdatedAt: r.snapshotUpdatedAt ? r.snapshotUpdatedAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listResumable(userId: string): Promise<ResumableSessionDto[]> {
  const cutoff = new Date(Date.now() - RESUMABLE_TTL_HOURS * 3600 * 1000);
  const rows = await prisma.aISession.findMany({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["active", "archived"] },
      snapshotUpdatedAt: { gte: cutoff },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return rows.map((r) => toListDto(r as unknown as SessionListRow));
}

export async function listExpired(userId: string): Promise<ResumableSessionDto[]> {
  const cutoff = new Date(Date.now() - RESUMABLE_TTL_HOURS * 3600 * 1000);
  const rows = await prisma.aISession.findMany({
    where: {
      userId,
      deletedAt: null,
      snapshotUpdatedAt: { lt: cutoff, not: null },
    },
    orderBy: { updatedAt: "desc" },
    take: 25,
  });
  return rows.map((r) => toListDto(r as unknown as SessionListRow));
}
