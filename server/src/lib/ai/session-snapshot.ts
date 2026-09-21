/**
 * Epic #165 (#122) — Session snapshot persistence.
 *
 * Periodically snapshots the full chat state (message history, current model,
 * loaded skills, custom-agent set) into `AISession.snapshot` so users can
 * close the tab and resume later. Snapshot frequency is governed by
 * `SESSION_SNAPSHOT_INTERVAL` (default {@link DEFAULT_SESSION_SNAPSHOT_INTERVAL}).
 */
import { prisma } from "../prisma.js";
import {
  DEFAULT_SESSION_SNAPSHOT_INTERVAL,
  type ResumableSessionDto,
  type SdkReasoningEffort,
  type SessionSnapshot,
} from "@metis/shared";

export class SessionSnapshotError extends Error {}

const RESUMABLE_TTL_HOURS = Number(process.env.SESSION_RESUME_TTL_HOURS ?? 24);

export function getSnapshotInterval(): number {
  const raw = process.env.SESSION_SNAPSHOT_INTERVAL;
  const n = raw ? Number(raw) : DEFAULT_SESSION_SNAPSHOT_INTERVAL;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_SNAPSHOT_INTERVAL;
  return Math.floor(n);
}

/**
 * Decide whether to snapshot now based on the running message count. Pure
 * function so the chat handler can call it without round-tripping through the
 * DB.
 */
export function shouldSnapshot(
  messageCount: number,
  interval: number = getSnapshotInterval(),
): boolean {
  if (messageCount <= 0) return false;
  return messageCount % interval === 0;
}

export async function writeSnapshot(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
  await prisma.aISession.update({
    where: { id: sessionId },
    data: {
      snapshot: JSON.stringify(snapshot),
      snapshotUpdatedAt: new Date(),
    },
  });
}

export async function readSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  const row = await prisma.aISession.findUnique({
    where: { id: sessionId },
    select: { snapshot: true },
  });
  if (!row || !row.snapshot) return null;
  try {
    const parsed = JSON.parse(row.snapshot);
    if (parsed && typeof parsed === "object" && parsed.v === 1) {
      return parsed as SessionSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

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

export async function rehydrate(sessionId: string): Promise<{
  session: ResumableSessionDto;
  snapshot: SessionSnapshot | null;
}> {
  const row = await prisma.aISession.findUnique({
    where: { id: sessionId },
  });
  if (!row) throw new SessionSnapshotError("Session not found");
  if (row.deletedAt) throw new SessionSnapshotError("Session deleted");
  if (row.snapshotUpdatedAt) {
    const cutoff = Date.now() - RESUMABLE_TTL_HOURS * 3600 * 1000;
    if (row.snapshotUpdatedAt.getTime() < cutoff) {
      throw new SessionSnapshotError("Session has expired and cannot be resumed");
    }
  }
  const snap = row.snapshot ? (JSON.parse(row.snapshot) as SessionSnapshot) : null;
  return {
    session: toListDto(row as unknown as SessionListRow),
    snapshot: snap,
  };
}
