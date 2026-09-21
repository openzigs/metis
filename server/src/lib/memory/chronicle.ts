/**
 * Epic #157 — Chronicle agentic memory (issue #116).
 *
 * Provides a per-project key-value store the agents use to remember durable
 * facts ("user prefers Postgres over MySQL", "this project's deploy target is
 * us-east-1") across sessions. Entries have an optional TTL so stale memory
 * gets purged automatically.
 *
 * Operations:
 *   - `recordEntry`   upsert by `(projectId, key)` with a fresh expiresAt.
 *   - `getEntries`    return non-expired entries; bulk-purge expired rows.
 *   - `forgetEntry`   delete by id (audit-logged, called from the UI).
 *   - `purgeExpired`  scan-and-delete; called from `getEntries` and from a
 *                     scheduled hook.
 *
 * Wiring:
 *   - `routes/ai.ts createSession` reads the most recent N entries and
 *     prepends them to the system prompt as "## Project memory (Chronicle)".
 *   - The agent tool `record_project_memory` calls `recordEntry`.
 *
 * The TTL is sourced from `Project.chronicleTtlDays`. When that field is null
 * we fall back to {@link DEFAULT_CHRONICLE_TTL_DAYS}.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("chronicle");

export const DEFAULT_CHRONICLE_TTL_DAYS = 28;
export const CHRONICLE_DEFAULT_LIMIT = 12;

export interface RecordEntryOptions {
  sessionId?: string | null;
  ttlDays?: number;
  /** Skip the audit row (used by the agent tool to keep audit volume bounded). */
  skipAudit?: boolean;
  actorId?: string;
}

export interface ChronicleEntryDto {
  id: string;
  projectId: string;
  key: string;
  value: string;
  sourceSessionId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function isChronicleEnabled(projectId: string): Promise<boolean> {
  const p = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { chronicleEnabled: true },
  });
  return Boolean(p?.chronicleEnabled);
}

async function resolveTtlDays(projectId: string, override?: number): Promise<number> {
  if (typeof override === "number" && override > 0) return override;
  const p = await prisma.project.findFirst({
    where: { id: projectId },
    select: { chronicleTtlDays: true },
  });
  return p?.chronicleTtlDays ?? DEFAULT_CHRONICLE_TTL_DAYS;
}

/**
 * Upsert (`projectId`, `key`). Returns the persisted entry. When chronicle is
 * disabled on the project, the call is a no-op and returns `null` so the agent
 * tool can report "not stored" without raising.
 */
export async function recordEntry(
  projectId: string,
  key: string,
  value: string,
  opts: RecordEntryOptions = {},
): Promise<ChronicleEntryDto | null> {
  if (!(await isChronicleEnabled(projectId))) {
    log.info("chronicle disabled — skipping record", { projectId, key });
    return null;
  }
  const ttlDays = await resolveTtlDays(projectId, opts.ttlDays);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const existing = await prisma.chronicleEntry.findFirst({
    where: { projectId, key },
  });
  const row = existing
    ? await prisma.chronicleEntry.update({
        where: { id: existing.id },
        data: {
          value,
          sourceSessionId: opts.sessionId ?? existing.sourceSessionId,
          expiresAt,
        },
      })
    : await prisma.chronicleEntry.create({
        data: {
          projectId,
          key,
          value,
          sourceSessionId: opts.sessionId ?? null,
          expiresAt,
        },
      });
  if (!opts.skipAudit) {
    audit({
      actor: opts.actorId ? { id: opts.actorId } : null,
      action: "chronicle.record",
      target: { type: "project", id: projectId },
      metadata: { key, sessionId: opts.sessionId ?? null, ttlDays },
    });
  }
  return toDto(row);
}

/** Get most-recent entries (non-expired) and lazily purge any that are. */
export async function getEntries(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<ChronicleEntryDto[]> {
  const limit = Math.min(Math.max(opts.limit ?? CHRONICLE_DEFAULT_LIMIT, 1), 100);
  await purgeExpired(projectId);
  const rows = await prisma.chronicleEntry.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toDto);
}

export async function forgetEntry(
  entryId: string,
  actor: { id: string } | null = null,
): Promise<boolean> {
  const row = await prisma.chronicleEntry.findFirst({ where: { id: entryId } });
  if (!row) return false;
  await prisma.chronicleEntry.delete({ where: { id: entryId } });
  audit({
    actor,
    action: "chronicle.forget",
    target: { type: "project", id: row.projectId },
    metadata: { key: row.key },
  });
  return true;
}

/** Bulk-delete every expired row for the project. Audit-logged when > 0. */
export async function purgeExpired(projectId?: string): Promise<number> {
  const now = new Date();
  const where = {
    expiresAt: { lt: now, not: null as Date | null },
    ...(projectId ? { projectId } : {}),
  };
  const result = await prisma.chronicleEntry.deleteMany({ where });
  if (result.count > 0 && projectId) {
    audit({
      actor: null,
      action: "chronicle.purge",
      target: { type: "project", id: projectId },
      metadata: { deleted: result.count },
    });
  }
  return result.count;
}

/**
 * Build the system-message block prepended to every chat call. Returns an
 * empty string when chronicle is disabled or there are no live entries.
 */
export async function buildSystemBlock(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<string> {
  if (!(await isChronicleEnabled(projectId))) return "";
  const entries = await getEntries(projectId, { limit: opts.limit });
  if (entries.length === 0) return "";
  const lines = entries
    .map((e) => `- **${e.key}**: ${e.value.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return `## Project memory (Chronicle)\n${lines}`;
}

function toDto(row: {
  id: string;
  projectId: string;
  key: string;
  value: string;
  sourceSessionId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}): ChronicleEntryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    value: row.value,
    sourceSessionId: row.sourceSessionId,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
