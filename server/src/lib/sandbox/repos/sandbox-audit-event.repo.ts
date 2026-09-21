/**
 * `SandboxAuditEvent` repository (Epic #395 #410, #413).
 *
 * APPEND-ONLY. The `update` and `delete` methods are intentionally not
 * exposed — `SandboxAuditEvent` rows are SOC 2 evidence and must remain
 * immutable. Callers add via `append`; querying is read-only.
 *
 * Tenant isolation: all read methods accept an optional `projectId`
 * parameter that — when supplied — is added to the WHERE clause via the
 * `session` relation. New code MUST pass `projectId` to defend against
 * cross-tenant audit-trail reads even when a session id leaks. Existing
 * callers may pass `undefined` for backward compat (issue #410's read
 * path was project-blind in the v0 implementation).
 */
import { prisma } from "../../prisma.js";
import type { SandboxAuditEventType } from "../types.js";

export interface SandboxAuditEventInput {
  sessionId: string;
  eventType: SandboxAuditEventType;
  /** Already-redacted payload. */
  payload: unknown;
}

export interface SandboxAuditEventRow {
  id: string;
  sessionId: string;
  eventType: string;
  payload: string;
  timestamp: Date;
}

export class SandboxAuditEventRepo {
  async append(input: SandboxAuditEventInput): Promise<SandboxAuditEventRow> {
    return prisma.sandboxAuditEvent.create({
      data: {
        sessionId: input.sessionId,
        eventType: input.eventType,
        payload: JSON.stringify(input.payload ?? {}),
      },
    });
  }

  /**
   * Look up a single event by id. When `projectId` is supplied, the
   * query joins through `session` and filters by `session.projectId` —
   * defense-in-depth against cross-tenant reads even if a row id leaks.
   */
  async findById(id: string, projectId?: string): Promise<SandboxAuditEventRow | null> {
    if (projectId === undefined) {
      return prisma.sandboxAuditEvent.findUnique({ where: { id } });
    }
    return prisma.sandboxAuditEvent.findFirst({
      where: { id, session: { projectId } },
    });
  }

  async listForSession(sessionId: string, projectId?: string): Promise<SandboxAuditEventRow[]> {
    return prisma.sandboxAuditEvent.findMany({
      where: {
        sessionId,
        ...(projectId !== undefined ? { session: { projectId } } : {}),
      },
      orderBy: { timestamp: "asc" },
    });
  }

  async countForSession(sessionId: string, projectId?: string): Promise<number> {
    return prisma.sandboxAuditEvent.count({
      where: {
        sessionId,
        ...(projectId !== undefined ? { session: { projectId } } : {}),
      },
    });
  }
}

let singleton: SandboxAuditEventRepo | null = null;
export function getSandboxAuditEventRepo(): SandboxAuditEventRepo {
  if (!singleton) singleton = new SandboxAuditEventRepo();
  return singleton;
}

/** Test helper. */
export function __resetSandboxAuditEventRepoSingleton(): void {
  singleton = null;
}
