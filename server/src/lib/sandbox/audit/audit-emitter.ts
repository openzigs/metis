/**
 * Sandbox audit emitter (Epic #395 #413).
 *
 * Adapter-agnostic surface that:
 *   1. Redacts the payload (drops `content`, `token`, `secret`, etc.).
 *   2. Writes a `SandboxAuditEvent` row.
 *   3. Emits a structured `info` log line for the existing log shipper.
 *
 * Audit failures MUST NOT block the data path — DB write errors are
 * downgraded to a `WARN` log so the sandbox operation still succeeds.
 * This matches the existing `audit-service.ts` "fire and forget" contract.
 */
import { createChildLogger } from "../../logger.js";
import {
  type SandboxAuditEventInput,
  type SandboxAuditEventRepo,
  getSandboxAuditEventRepo,
} from "../repos/sandbox-audit-event.repo.js";
import type { SandboxAuditEventType, SandboxProviderKind } from "../types.js";
import { redactSandboxPayload } from "./redact.js";

const log = createChildLogger("sandbox.audit");

/** Lifecycle context attached to every emit so downstream queries can pivot. */
export interface SandboxAuditContext {
  sessionId: string;
  projectId: string;
  userId?: string | null;
  provider: SandboxProviderKind;
}

export class SandboxAuditEmitter {
  constructor(private readonly repo: SandboxAuditEventRepo = getSandboxAuditEventRepo()) {}

  /**
   * Persist + log a single audit event. Always resolves — DB failures are
   * captured to `WARN`, never rejected to the caller.
   */
  async emit(
    ctx: SandboxAuditContext,
    eventType: SandboxAuditEventType,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const redacted = redactSandboxPayload(payload) as Record<string, unknown>;
    log.info("sandbox.event", {
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      userId: ctx.userId ?? null,
      provider: ctx.provider,
      eventType,
      payload: redacted,
    });
    try {
      const input: SandboxAuditEventInput = {
        sessionId: ctx.sessionId,
        eventType,
        payload: redacted,
      };
      await this.repo.append(input);
    } catch (err) {
      log.warn("sandbox.audit.write_failed", {
        sessionId: ctx.sessionId,
        eventType,
        error: (err as Error).message,
      });
    }
  }
}

let singleton: SandboxAuditEmitter | null = null;
export function getSandboxAuditEmitter(): SandboxAuditEmitter {
  if (!singleton) singleton = new SandboxAuditEmitter();
  return singleton;
}

/** Test helper. */
export function __resetSandboxAuditEmitterSingleton(): void {
  singleton = null;
}
